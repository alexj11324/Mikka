#!/usr/bin/env node
// Offline official-auth protocol fixture. Contains only synthetic tokens.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { execFileSync, spawn } from "node:child_process"

if (process.argv.some(arg => arg.startsWith('model_providers.openai.'))) {
  process.stderr.write('Reserved built-in model provider cannot be overridden\n')
  process.exit(2)
}

const send = (value) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`)
const pending = new Map()
let login = null
let experimental = false
let turn = 0
const lines = createInterface({ input: process.stdin })
lines.on("line", async (line) => {
  const { id, method, params, result, error } = JSON.parse(line)
  if (!method) {
    const settled = pending.get(id)
    pending.delete(id)
    settled?.({ result, error })
    return
  }
  if (id === undefined) return
  if (method === "initialize") {
    experimental = params.capabilities?.experimentalApi === true
    return send({ id, result: { userAgent: process.env.FAKE_CODEX_USER_AGENT ?? "codex_cli_rs/0.163.0 synthetic-fixture" } })
  }
  if (method === "account/login/start") {
    // Real Codex parses ChatGPT JWT claims. Never conceal the hosted runner's
    // old bug by accepting its opaque public marker as an OAuth credential.
    if (params.accessToken === "mikka-native-broker-placeholder")
      return send({ id, error: { code: -32603, message: "Invalid OAuth token framing" } });
    if (
      !experimental ||
      params.type !== "chatgptAuthTokens" ||
      Object.keys(params).some(
        (key) =>
          ![
            "type",
            "accessToken",
            "chatgptAccountId",
            "chatgptPlanType"
          ].includes(key)
      ) ||
      existsSync(join(process.env.CODEX_HOME, "auth.json")) ||
      process.env.OPENAI_API_KEY
    )
      return send({
        id,
        error: { code: -1, message: "fixture auth boundary failed" }
      })
    if (params.accessToken === "fixture-unsupported")
      return send({
        id,
        error: { code: -1, message: "fixture-secret-must-not-leak" }
      })
    if (params.accessToken === "fixture-paid-mode")
      return send({ id, result: { type: "apiKey" } })
    login = params
    return send({ id, result: { type: "chatgptAuthTokens" } })
  }
  const historyFile = join(process.env.CODEX_HOME, "sessions", "fixture-subscription-thread.json")
  if (method === "thread/resume") {
    if (!existsSync(historyFile)) return send({ id, error: { code: -32600, message: "Original thread unavailable" } })
    const history = JSON.parse(readFileSync(historyFile, "utf8"))
    if (params.threadId !== history.sessionId) return send({ id, error: { code: -32600, message: "Original thread unavailable" } })
    writeFileSync(join(process.env.CODEX_HOME, 'fixture-resume.json'), JSON.stringify({ method, threadId: params.threadId }))
    return send({ id, result: { thread: { id: history.resumeSessionId ?? history.sessionId } } })
  }
  if (method === "thread/start") {
    // The owned hosted broker uses Codex's documented custom Responses
    // provider, independently of the direct/local ChatGPT login fixture.
    if (!login && process.env.MIKKA_MODEL_API_KEY === "mikka-native-broker-placeholder" &&
      process.argv.includes('model_provider="mikka"') &&
      process.argv.includes('model_providers.mikka.requires_openai_auth=false') &&
      process.argv.some(arg => /^model_providers\.mikka\.base_url="http:\/\/127\.0\.0\.1:\d+"$/.test(arg)) &&
      !existsSync(join(process.env.CODEX_HOME, "auth.json")) && !process.env.OPENAI_API_KEY)
      login = { type: "ownedBroker" };
    if (!login)
      return send({
        id,
        error: { code: -1, message: "subscription login required" }
      })
    mkdirSync(join(process.env.CODEX_HOME, "sessions"), { recursive: true })
    writeFileSync(historyFile, JSON.stringify({ sessionId: "fixture-subscription-thread", messages: [] }))
    return send({
      id,
      result: { thread: { id: "fixture-subscription-thread" } }
    })
  }
  if (method === "turn/start") {
    const turnId = `fixture-turn-${++turn}`
    send({ id, result: { turn: { id: turnId } } })
    const prompt = params.input[0].text
    if (existsSync(historyFile)) {
      const history = JSON.parse(readFileSync(historyFile, "utf8")); history.messages.push(prompt)
      writeFileSync(historyFile, JSON.stringify(history))
    }
    if (prompt === 'ORIGINAL_QUESTION') {
      const args = JSON.parse(process.argv.find(value => value.startsWith('mcp_servers.mikka.args=')).slice('mcp_servers.mikka.args='.length))
      execFileSync(process.execPath, args, { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_human', arguments: { question: 'Please provide the owner answer', kind: 'external' } } }) + '\n', stdio: ['pipe', 'pipe', 'pipe'] })
    }
    const fullComputer = prompt === 'FULL_COMPUTER' || prompt.startsWith('# FULL_COMPUTER\n')
    if (prompt === 'COMPUTER' || fullComputer) {
      async function call(server, name, args) {
        const prefix = `mcp_servers.${server}.args=`
        const configured = process.argv.find(value => value.startsWith(prefix))
        if (!configured) process.exit(2)
        const proxy = spawn('node', JSON.parse(configured.slice(prefix.length)), { stdio: ['pipe', 'pipe', 'ignore'] })
      const reply = new Promise((resolve, reject) => {
        const reader = createInterface({ input: proxy.stdout })
        reader.once('line', line => { reader.close(); resolve(JSON.parse(line)) })
        proxy.once('error', reject)
        proxy.once('exit', code => { if (code) reject(new Error('computer proxy failed')) })
      })
      proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
      const answer = await reply
      proxy.kill()
      if (answer.result?.isError) process.exit(2)
      }
      if (fullComputer) await call('mikka_computer', 'get_desktop_state', {})
      await call('mikka_computer', 'click', fullComputer ? { x: 150, y: 150 } : { x: 3, y: 4 })
      if (fullComputer) await call('mikka_computer', 'press_key', { key: 'tab' })
      if (fullComputer) await call('mikka_computer', 'scroll', { direction: 'down', amount: 2, x: 150, y: 150 })
      if (fullComputer) await call('mikka', 'submit', { summary: 'Synthetic computer task completed' })
    }
    if(prompt==='PROBE_GIT') {
      // Runs use no sandbox (decision 2026-11-01-2335): this probe only checks the run's gh wrapper.
      if (process.env.GH_HOST && !execFileSync('gh', ['--version'], { encoding: 'utf8' }).startsWith('gh version')) process.exit(2)
    }
    if (prompt.includes("FAIL")) {
      send({
        method: "error",
        params: {
          error: { message: "fixture-secret-must-not-leak" },
          willRetry: false
        }
      })
      send({
        method: "turn/completed",
        params: {
          threadId: "fixture-subscription-thread",
          turn: {
            id: turnId,
            status: "failed",
            error: { message: "fixture-secret-must-not-leak" }
          }
        }
      })
      return
    }
    if (prompt.includes("CRASH")) {
      process.stderr.write("fixture-secret-must-not-leak")
      setTimeout(() => process.exit(1), 10)
      return
    }
    if (prompt.includes("REFRESH")) {
      const key = `refresh-${turn}`
      const reply = new Promise((resolve) => pending.set(key, resolve))
      send({
        id: key,
        method: "account/chatgptAuthTokens/refresh",
        params: {
          reason: "unauthorized",
          previousAccountId: prompt.includes("WRONG")
            ? "other-account"
            : login.chatgptAccountId
        }
      })
      const response = await reply
      if (
        response.error ||
        response.result?.chatgptAccountId !== login.chatgptAccountId ||
        response.result?.accessToken !== "fixture-access-rotated"
      )
        return
    }
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "fixture-subscription-thread",
        turnId,
        itemId: "fixture-text",
        delta: "Subscription fixture completed"
      }
    })
    send({
      method: "turn/completed",
      params: {
        threadId: "fixture-subscription-thread",
        turn: { id: turnId, status: "completed", error: null }
      }
    })
    return
  }
  if (method === "turn/interrupt") return send({ id, result: {} })
  send({ id, result: {} })
})
lines.on("close", () => process.exit(0))
