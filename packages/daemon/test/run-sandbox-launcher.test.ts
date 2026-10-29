// Synthetic CLI / loopback-only acceptance. No account, provider or model API.
// Temp dirs and diagnostic output are retained for inspecting a failed CI run.
import { mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { createServer as createNetServer, type Socket } from "node:net"
import { createInterface } from 'node:readline'
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { runNetworkApproval } from '../src/agents/run-network'

import { describe, expect, it } from "vitest"

import {
  matchesRunSandboxDomain,
  spawnRunSandbox,
  type RunSandboxChild,
  type RunSandboxNetworkRequest,
} from "../src/agents/run-sandbox-launcher"

describe("run sandbox domain ceiling", () => {
  it("refuses Linux's warn-only missing-seccomp mode before sandbox startup", async () => {
    const { assertRunSandboxDependencies } = await import(new URL("../src/agents/run-sandbox-worker.mjs", import.meta.url).href)
    expect(() => assertRunSandboxDependencies({ errors: [], warnings: ["seccomp not available - unix socket access not restricted"] }, "linux"))
      .toThrow("sandbox isolation dependencies unsafe")
    expect(() => assertRunSandboxDependencies({ errors: ["socat not installed"], warnings: [] }, "linux"))
      .toThrow("sandbox dependencies unavailable")
    expect(() => assertRunSandboxDependencies({ errors: [], warnings: [] }, "linux")).not.toThrow()
  })

  it("requires a concrete valid destination even under an explicit unrestricted cap", () => {
    for (const host of ["", "*.example.com", "a.example.com\0", "a.example.com/other", "a.example.com@evil.com"]) {
      expect(matchesRunSandboxDomain({ host, port: 443 }, ["*"])).toBe(false)
    }
    expect(matchesRunSandboxDomain({ host: "api.example.com", port: 443 }, [])).toBe(false)
    expect(matchesRunSandboxDomain({ host: "api.example.com", port: 443 }, ["*"])).toBe(true)
    expect(matchesRunSandboxDomain({ host: "api.example.com", port: 0 }, ["*"])).toBe(false)
  })

  it("matches strict subdomains, canonical IPs and explicit ports without widening them", () => {
    const cap = ["*.example.com:443", "[::1]:8443", "127.0.0.1:1234"]
    expect(matchesRunSandboxDomain({ host: "API.Example.COM", port: 443 }, cap)).toBe(true)
    expect(matchesRunSandboxDomain({ host: "example.com", port: 443 }, cap)).toBe(false)
    expect(matchesRunSandboxDomain({ host: "evil-example.com", port: 443 }, cap)).toBe(false)
    expect(matchesRunSandboxDomain({ host: "api.example.com", port: 80 }, cap)).toBe(false)
    expect(matchesRunSandboxDomain({ host: "0:0:0:0:0:0:0:1", port: 8443 }, cap)).toBe(true)
    expect(matchesRunSandboxDomain({ host: "127.1", port: 1234 }, cap)).toBe(true)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function deadline<T>(promise: Promise<T>, label: string, ms = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

interface Output { type: string; id?: string; status?: number; attribution?: string; value?: string }

function output(child: RunSandboxChild) {
  let text = ""
  let tail = ""
  const messages: Output[] = []
  const waiters: { match: (value: Output) => boolean; resolve: (value: Output) => void }[] = []
  child.process.stdout.on("data", (chunk: Buffer) => {
    text += chunk.toString()
    tail += chunk.toString()
    for (let end; (end = tail.indexOf("\n")) >= 0;) {
      const line = tail.slice(0, end)
      tail = tail.slice(end + 1)
      const value = JSON.parse(line) as Output
      const index = waiters.findIndex((waiter) => waiter.match(value))
      if (index >= 0) waiters.splice(index, 1)[0].resolve(value)
      else messages.push(value)
    }
  })
  return {
    text: () => text,
    next(match: (value: Output) => boolean) {
      const index = messages.findIndex(match)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return deadline(new Promise<Output>((resolve) => waiters.push({ match, resolve })), "synthetic CLI output")
    },
  }
}

const HTTP_CLI = String.raw`
const http = require('node:http');
const readline = require('node:readline');
const proxy = new URL(process.env.HTTP_PROXY);
const emit = (value) => process.stdout.write(JSON.stringify(value)+'\n');
emit({type:'ready',attribution:decodeURIComponent(proxy.username)});
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const command = JSON.parse(line);
  const target = new URL(command.url);
  const username = command.username ?? decodeURIComponent(proxy.username);
  const headers = {host:target.host,'proxy-authorization':'Basic '+Buffer.from(username+':'+decodeURIComponent(proxy.password)).toString('base64')};
  const request = http.request({hostname:proxy.hostname==='localhost'?'127.0.0.1':proxy.hostname,port:proxy.port,path:target.href,headers,agent:false}, (response) => {
    emit({type:'headers',id:command.id,status:response.statusCode});
    response.resume();
    response.once('end', () => emit({type:'end',id:command.id,status:response.statusCode}));
  });
  request.on('error', () => emit({type:'request-error',id:command.id}));
  request.end();
});
`

async function loopback() {
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const streaming = deferred<void>()
  const streamClosed = deferred<void>()
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    if (request.url === "/stream") {
      response.writeHead(200)
      response.write("open")
      response.once("close", () => streamClosed.resolve())
      streaming.resolve()
    } else response.end("synthetic-ok")
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing synthetic loopback server address")
  return { server, sockets, requests, port: address.port, url: `http://127.0.0.1:${address.port}`, streaming, streamClosed }
}

async function closeServer(server: Server, sockets: Set<Socket>) {
  // These sockets/server belong solely to this test, never shared resources.
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function launch(
  dir: string,
  maxAllowDomains: readonly string[],
  onNetwork: (request: RunSandboxNetworkRequest, signal: AbortSignal) => Promise<boolean>,
  extra: { args?: string[]; authToken?: string; env?: Record<string,string> } = {}
) {
  return spawnRunSandbox({
    command: process.execPath,
    args: extra.args ?? ["-e", HTTP_CLI],
    cwd: dir,
    // Synthetic CLI sees no ambient credentials/provider configuration.
    env: { PATH: process.env.PATH, HOME: dir, ...extra.env },
    policy: { allowWrite: [dir], denyRead: [], denyWrite: [], allowDomains: [...maxAllowDomains] },
    maxAllowDomains,
    onNetwork,
    ...(extra.authToken !== undefined ? { authToken: extra.authToken } : {}),
  })
}

describe.skipIf(process.env.MIKKA_SANDBOX_ACCEPTANCE !== "1")("official per-run launcher Linux acceptance", () => {
  it('connects the actual computer MCP proxy only to its trusted run broker without a second approval', async () => {
    const dir = mkdtempSync(join(tmpdir(),'mikka-launcher-computer-'))
    console.info(`Retained synthetic computer transport evidence: ${dir}`)
    const sockets = new Set<Socket>(), calls: unknown[] = []
    const server = createNetServer(socket => {
      sockets.add(socket); socket.once('close',() => sockets.delete(socket))
      const lines = createInterface({input:socket})
      lines.once('line',line => {
        const frame = JSON.parse(line)
        calls.push(frame)
        socket.end(JSON.stringify(frame.token === 'synthetic-request-only' && frame.call.name === 'get_desktop_state'
          ? {result:{content:[{type:'text',text:'synthetic-desktop-state'}]}}
          : {error:'denied'})+'\n')
      })
    })
    await new Promise<void>(done => server.listen(0,'127.0.0.1',done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing broker port')
    const endpoint = `127.0.0.1:${address.port}`, maximum = [endpoint]
    let asks = 0
    const gate = new ToolApprovalGate('computer-run',{permission:()=> 'deny',ask:async()=>{asks++;return 'deny'},isLive:()=>true})
    const child = launch(dir,maximum,runNetworkApproval('computer-run','claude_code',gate,maximum,endpoint),{
      args:[resolve('src/computer/proxy.mjs'),`tcp://${endpoint}`,'synthetic-request-only'],
      env:{MIKKA_COMPUTER_SANDBOX_PROXY:'1'},
    })
    const off = gate.onRevoke(() => { void child.revoke() })
    const answer = deferred<{result:{content:{type:string;text:string}[]}}>()
    const lines = createInterface({input:child.process.stdout})
    lines.on('line',line => { const frame=JSON.parse(line); if(frame.id===2)answer.resolve(frame) })
    try {
      child.process.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n')
      child.process.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_desktop_state',arguments:{},_meta:{progressToken:2,'claudecode/toolUseId':'synthetic-call'}}})+'\n')
      const reply = await deadline(answer.promise,'actual sandboxed computer MCP transport')
      expect(reply.result.content).toContainEqual({type:'text',text:'synthetic-desktop-state'})
      expect(calls).toHaveLength(1)
      expect(asks).toBe(0)
      writeFileSync(join(dir,'evidence.json'),JSON.stringify({actualProxy:true,actualSandbox:true,syntheticBroker:true,calls,reply}))
      gate.revoke()
      await deadline(child.exited,'revoked computer proxy exit')
    } finally {
      off(); gate.revoke(); await child.revoke(); lines.close()
      for(const socket of sockets)socket.destroy()
      await new Promise<void>(done=>server.close(()=>done()))
    }
  })

  it("isolates simultaneous approvals and ignores replayed proxy attribution", async () => {
    expect(process.platform).toBe("linux")
    const dir = mkdtempSync(join(tmpdir(), "mikka-launcher-isolation-"))
    console.info(`Retained synthetic sandbox evidence: ${dir}`)
    const origin = await loopback()
    const aAsked = deferred<RunSandboxNetworkRequest>()
    const bAsked = deferred<RunSandboxNetworkRequest>()
    const aDecision = deferred<boolean>()
    const bDecision = deferred<boolean>()
    let aCalls = 0
    let bCalls = 0
    const maximum = [`127.0.0.1:${origin.port}`]
    const a = launch(dir, maximum, async (request) => { aCalls++; aAsked.resolve(request); return aDecision.promise })
    const b = launch(dir, maximum, async (request) => { bCalls++; bAsked.resolve(request); return bDecision.promise })
    const aOut = output(a)
    const bOut = output(b)
    try {
      const [aReady, bReady] = await Promise.all([aOut.next((v) => v.type === "ready"), bOut.next((v) => v.type === "ready")])
      expect(aReady.attribution).not.toBe(bReady.attribution)
      a.process.stdin.write(JSON.stringify({ id: "a", url: `${origin.url}/a` }) + "\n")
      // Replay A's username while preserving B's transport authentication.
      b.process.stdin.write(JSON.stringify({ id: "b", url: `${origin.url}/b`, username: aReady.attribution }) + "\n")
      await deadline(Promise.all([aAsked.promise, bAsked.promise]), "both run callbacks")
      aDecision.resolve(true)
      expect((await aOut.next((v) => v.id === "a" && v.type === "end")).status).toBe(200)
      expect(origin.requests).toEqual(["/a"])
      bDecision.resolve(false)
      expect((await bOut.next((v) => v.id === "b" && v.type === "end")).status).toBe(403)
      expect(aCalls).toBe(1)
      expect(bCalls).toBe(1)
      expect(origin.requests).toEqual(["/a"])

      // Mutating the caller's array cannot widen either captured ceiling.
      maximum.push("*")
      a.process.stdin.write(JSON.stringify({ id: "outside", url: "http://127.0.0.1:1/outside" }) + "\n")
      expect((await aOut.next((v) => v.id === "outside" && v.type === "end")).status).toBe(403)
      expect(aCalls).toBe(1)
    } finally {
      aDecision.resolve(false)
      bDecision.resolve(false)
      await Promise.all([a.revoke(), b.revoke()])
      writeFileSync(join(dir, "a.log"), aOut.text() + a.stderrTail())
      writeFileSync(join(dir, "b.log"), bOut.text() + b.stderrTail())
      await closeServer(origin.server, origin.sockets)
    }
  }, 60_000)

  it("revokes pending decisions and established proxy streams without accepting a late allow", async () => {
    expect(process.platform).toBe("linux")
    const dir = mkdtempSync(join(tmpdir(), "mikka-launcher-revoke-"))
    console.info(`Retained synthetic sandbox evidence: ${dir}`)
    const origin = await loopback()
    const pending = deferred<boolean>()
    const asked = deferred<AbortSignal>()
    let calls = 0
    const child = launch(dir, [`127.0.0.1:${origin.port}`], async (_request, signal) => {
      if (++calls === 1) return true
      asked.resolve(signal)
      return pending.promise
    })
    const out = output(child)
    try {
      await out.next((v) => v.type === "ready")
      child.process.stdin.write(JSON.stringify({ id: "stream", url: `${origin.url}/stream` }) + "\n")
      await deadline(origin.streaming.promise, "established stream")
      child.process.stdin.write(JSON.stringify({ id: "pending", url: `${origin.url}/pending` }) + "\n")
      const signal = await deadline(asked.promise, "pending approval")
      const revoked = child.revoke()
      expect(signal.aborted).toBe(true)
      pending.resolve(true)
      await deadline(Promise.all([revoked, origin.streamClosed.promise]), "revocation closes child and stream")
      expect(origin.requests).toEqual(["/stream"])
      expect(calls).toBe(2)
    } finally {
      pending.resolve(false)
      await child.revoke()
      writeFileSync(join(dir, "child.log"), out.text() + child.stderrTail())
      await closeServer(origin.server, origin.sockets)
    }
  }, 60_000)

  it("delivers a synthetic token only on fd3 and preserves the first protocol bytes", async () => {
    expect(process.platform).toBe("linux")
    const dir = mkdtempSync(join(tmpdir(), "mikka-launcher-auth-frame-"))
    console.info(`Retained synthetic sandbox evidence: ${dir}`)
    const protocol = "first\0protocol\n" + "x".repeat(128 * 1024)
    const syntheticToken = "synthetic-test-token-no-provider"
    const script = String.raw`
const fs=require('node:fs');
const crypto=require('node:crypto');
const token=fs.readFileSync(Number(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR));
const input=[];
process.stdin.on('data',(chunk)=>input.push(chunk));
process.stdin.on('end',()=>{
  const bytes=Buffer.concat(input);
  process.stdout.write(JSON.stringify({type:'result',value:JSON.stringify({tokenHash:crypto.createHash('sha256').update(token).digest('hex'),protocolHash:crypto.createHash('sha256').update(bytes).digest('hex'),hasTokenEnv:Object.hasOwn(process.env,'CLAUDE_CODE_OAUTH_TOKEN')})})+'\n');
  token.fill(0);
});`
    const child = launch(dir, [], async () => { throw new Error("no network expected") }, { args: ["-e", script], authToken: syntheticToken })
    const out = output(child)
    try {
      // Write immediately, while the host worker is still initializing. The
      // bridge must preserve binary bytes and apply normal pipe backpressure.
      child.process.stdin.end(protocol)
      const value = JSON.parse((await out.next((v) => v.type === "result")).value!) as {
        tokenHash: string; protocolHash: string; hasTokenEnv: boolean
      }
      const { createHash } = await import("node:crypto")
      expect(value.tokenHash).toBe(createHash("sha256").update(syntheticToken).digest("hex"))
      expect(value.protocolHash).toBe(createHash("sha256").update(protocol).digest("hex"))
      expect(value.hasTokenEnv).toBe(false)
      expect(await deadline(child.exited, "synthetic auth CLI exit")).toEqual({ code: 0, signal: null })
      expect(out.text() + child.stderrTail()).not.toContain(syntheticToken)
    } finally {
      await child.revoke()
      writeFileSync(join(dir, "child.log"), out.text() + child.stderrTail())
    }
  }, 60_000)
})
