#!/usr/bin/env node
// Synthetic native-auth process only; no provider/network requests.
import { closeSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { execFileSync, spawn } from "node:child_process"

const args = process.argv.slice(2)
const flag = (key) => {
  const inline = args.find((arg) => arg.startsWith(`${key}=`))
  if (inline) return inline.slice(key.length + 1)
  const at = args.indexOf(key)
  return at < 0 ? undefined : args[at + 1]
}
if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR !== "3") process.exit(2)
const token = readFileSync(3, "utf8")
closeSync(3)
const config = process.env.CLAUDE_CONFIG_DIR
if (
  !token ||
  !config ||
  config !== join(process.env.HOME, ".claude") ||
  existsSync(join(config, ".credentials.json")) ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.E2B_API_KEY ||
  Object.keys(process.env).some((key) => /REFRESH_TOKEN|INFISICAL/.test(key))
)
  process.exit(2)
const requestedSession = flag("--session-id") ?? flag("--resume")
const historyFile = join(config, "projects", "fixture-question.json")
let history
if (flag('--resume') !== undefined) {
  if (!existsSync(historyFile)) process.exit(2)
  history = JSON.parse(readFileSync(historyFile, "utf8"))
  if (history.sessionId !== requestedSession) process.exit(2)
} else {
  mkdirSync(join(config, "projects"), { recursive: true })
  history = { sessionId: requestedSession, messages: [] }
}
const sessionId = history.resumeSessionId ?? requestedSession
writeFileSync(historyFile, JSON.stringify(history))
// Capture only the official effort flag and session identity, never auth argv/env.
writeFileSync(join(config, 'fixture-effort.json'), JSON.stringify({ transport: 'cli', sessionId, effort: flag('--effort') ?? null, resumed: flag('--resume') !== undefined }))
const processReceipt = join(config, 'fixture-process.json')
let prompts = 0
writeFileSync(processReceipt, JSON.stringify({ pid: process.pid, prompts }))
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const lines = createInterface({ input: process.stdin })
lines.on("line", async (line) => {
  const frame = JSON.parse(line)
  if (frame.type === "control_request") {
    if (token === 'fixture-timeout') return
    if (token.startsWith('fixture-delayed')) await new Promise(resolve => setTimeout(resolve, 12_000))
    out({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: frame.request_id,
        response: {
          commands: [],
          agents: [],
          models: [],
          account: {
            apiProvider: ["fixture-gateway", "fixture-delayed-gateway"].includes(token) ? "gateway" : "firstParty",
            // Official 2.1.309 omits apiKeySource for descriptor-delivered OAuth.
            ...(["fixture-paid", "fixture-delayed-paid"].includes(token) ? { apiKeySource: "ANTHROPIC_API_KEY" } : token === "fixture-legacy" ? { apiKeySource: "none" } : {}),
            ...(["fixture-unknown", "fixture-delayed-unknown"].includes(token) ? {} : { tokenSource: token === "fixture-environment" ? "CLAUDE_CODE_OAUTH_TOKEN" : "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" })
          }
        }
      }
    })
    return
  }
  const text = frame.message?.content?.[0]?.text
  if (typeof text !== "string") return
  prompts++
  history.messages.push(text); writeFileSync(historyFile, JSON.stringify(history))
  writeFileSync(processReceipt, JSON.stringify({ pid: process.pid, prompts }))
  if (text === 'ORIGINAL_QUESTION') {
    const server = JSON.parse(flag('--mcp-config')).mcpServers.mikka
    execFileSync(server.command, server.args, { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_human', arguments: { question: 'Please provide the owner answer', kind: 'external' } } }) + '\n', stdio: ['pipe', 'pipe', 'pipe'] })
  }
  if (text === 'COMPUTER') {
    const config = JSON.parse(flag('--mcp-config') ?? '{}').mcpServers?.mikka_computer
    if (!config || !/(^|\/)node$/.test(config.command)) process.exit(2)
    const proxy = spawn(config.command, config.args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const reply = new Promise((resolve, reject) => {
      const reader = createInterface({ input: proxy.stdout })
      reader.once('line', line => { reader.close(); resolve(JSON.parse(line)) })
      proxy.once('error', reject)
      proxy.once('exit', code => { if (code) reject(new Error('computer proxy failed')) })
    })
    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'click', arguments: { x: 3, y: 4 } } }) + '\n')
    const answer = await reply
    proxy.kill()
    if (answer.result?.isError) process.exit(2)
  }
  if(text==='PROBE_GIT') {
    // Runs use no sandbox (decision 2026-11-01-2335): this probe only checks the run's gh wrapper.
    if (process.env.GH_HOST && !execFileSync('gh', ['--version'], { encoding: 'utf8' }).startsWith('gh version')) process.exit(2)
  }
  out({ type: "system", subtype: "init", session_id: sessionId })
  if (text === "CRASH") {
    process.stderr.write(`private upstream diagnostic ${token}`)
    process.exit(1)
  }
  if (text === "HANG") return
  if (text === "API_ERROR" || text === "MAX_TURNS" || text === "IMAGE_ERROR") {
    process.stderr.write(`upstream said Authorization: Bearer ${token} sk-ant-oat01-fixturesecret\n`)
    if (text === "API_ERROR")
      out({ type: "assistant", session_id: sessionId, error: "overloaded",
        message: { id: "api", content: [{ type: "text", text: `API Error: 529 ${token}` }] } })
    out({
      type: "result",
      subtype: text === "MAX_TURNS" ? "error_max_turns" : "success",
      session_id: sessionId,
      is_error: true,
      ...(text === "MAX_TURNS" ? { errors: [`private diagnostic ${token}`] } : { result: `API Error: 529 ${token}` }),
      ...(text === "API_ERROR" ? { api_error_status: 529, terminal_reason: "api_error" } : {}),
      ...(text === "IMAGE_ERROR" ? { api_error_status: 400, terminal_reason: "image_error" } : {}),
      ...(text === "MAX_TURNS" ? { terminal_reason: "max_turns" } : {}),
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    return
  }
  if (text === "FAIL") {
    out({
      type: "assistant",
      session_id: sessionId,
      error: "authentication_failed",
      message: {
        id: "auth",
        content: [{ type: "text", text: `private diagnostic ${token}` }]
      }
    })
  } else {
    out({
      type: "assistant",
      session_id: sessionId,
      message: {
        id: "ok",
        content: [{ type: "text", text: "native lease accepted by fixture" }]
      }
    })
  }
  out({
    type: "result",
    subtype: text === "FAIL" ? "error_during_execution" : "success",
    session_id: sessionId,
    is_error: text === "FAIL",
    errors: text === "FAIL" ? [`private diagnostic ${token}`] : [],
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 }
  })
})
lines.on("close", () => process.exit(0))
