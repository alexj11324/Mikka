import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RpcServer, type RpcHandlers } from "../rpc/server"
import { connectDaemon } from "../rpc/client"
import { DAEMON_PROTOCOL_VERSION } from "@mikka/protocol"
import { ComputerBroker } from "./broker.mjs"
import { RunContext } from "../agents/run-context"

test("only authenticated owner RPC can decide; exact approved result unblocks waiting operation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cua-rpc-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const broker = new ComputerBroker({
    driver: {
      installed: true,
      path: "/test",
      version: "cua-driver 0.38.0",
      fingerprint: "digest",
    },
    socketPath: join(dir, "computer"),
    permitted: () => true,
    execute: async () => ({
      content: [{ type: "text", text: "real operation result" }],
    }),
  })
  t.after(() => broker.close())
  const handlers = {
    "computer.pending": () => broker.list(),
    "computer.decide": ({ id, digest, approve }: any) =>
      broker.decide(id, digest, approve),
  } as unknown as RpcHandlers
  const log = { error() {}, warn() {}, info() {}, debug() {} } as any
  const server = new RpcServer({
    socketPath: join(dir, "rpc"),
    secret: "test-owner-only",
    hello: () =>
      ({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        daemonVersion: "0.0.1",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        flavor: "dev",
        dataDir: dir,
      }) as any,
    handlers,
    log,
  })
  await server.listen()
  t.after(() => server.close())
  const options = {
    socketPath: join(dir, "rpc"),
    secret: "test-owner-only",
    client: { name: "test-owner", version: "1" },
  }
  await assert.rejects(() =>
    connectDaemon({ ...options, secret: "model-does-not-have-owner-secret" })
  )
  const owner = await connectDaemon(options)
  t.after(() => owner.close())
  const grant = broker.spec("run", "ask")!
  const promise = broker.request(grant.token, {
    name: "click",
    arguments: { x: 1, y: 2 },
  })
  const [pending] = await owner.request("computer.pending")
  assert.equal(pending.runId, "run")
  await owner.request("computer.decide", {
    id: pending.id,
    digest: pending.digest,
    approve: true,
  })
  assert.deepEqual(await promise, {
    content: [{ type: "text", text: "real operation result" }],
  })
  await assert.rejects(() =>
    owner.request("computer.decide", {
      id: pending.id,
      digest: pending.digest,
      approve: true,
    })
  )
})
test("common adapter context injects a second independent proxy server, never raw driver", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cua-context-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, "private"))
  for (const harness of ["claude_code", "codex", "cursor"] as const) {
    const opts = {
      harness,
      worktree: process.cwd(),
      runDir: join(dir, harness),
      privateDir: join(dir, "private"),
    }
    assert.deepEqual(Object.keys(new RunContext(opts).mcpServers()), ["mikka"])
    const proxy = {
      command: process.execPath,
      args: ["proxy.mjs", "/request-only", "token"],
      env: {},
    }
    const servers = new RunContext({
      ...opts,
      computerMcp: proxy,
    }).mcpServers()
    assert.deepEqual(Object.keys(servers), ["mikka", "computer"])
    assert.deepEqual(servers.computer, proxy)
  }
})
