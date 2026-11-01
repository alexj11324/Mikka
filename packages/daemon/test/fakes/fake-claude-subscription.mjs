#!/usr/bin/env node
// Synthetic native-auth process only; no provider/network requests.
import { closeSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { execFileSync, spawn } from "node:child_process"

const args = process.argv.slice(2)
const flag = (key) => {
  const inline = args.find((arg) => arg.startsWith(`${key}=`))
  if (inline) return inline.slice(key.length + 1)
  return args[args.indexOf(key) + 1]
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
const sessionId = flag("--session-id") ?? flag("--resume")
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const lines = createInterface({ input: process.stdin })
lines.on("line", async (line) => {
  const frame = JSON.parse(line)
  if (frame.type === "control_request") {
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
            apiProvider: token === "fixture-gateway" ? "gateway" : "firstParty",
            apiKeySource:
              token === "fixture-paid" ? "ANTHROPIC_API_KEY" : "none"
          }
        }
      }
    })
    return
  }
  const text = frame.message?.content?.[0]?.text
  if (typeof text !== "string") return
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
    // A host file the run's sandbox must hide (the worker's device credential).
    // The run's home is <data dir>/adapters/runs/<run>/<home>; the worker's device.json is in <data dir>.
    if (process.env.HOME) { let content = ""; try { content = readFileSync(join(process.env.HOME, "..", "..", "..", "..", "device.json"), "utf8") } catch {} if (content.includes("fixture-device-credential")) process.exit(2) }
    if (process.env.GH_REPO && !execFileSync('gh', ['--version'], { encoding: 'utf8' }).startsWith('gh version')) process.exit(2)
    const target=lstatSync('.git').isFile()?'.git':'.git/guard'
    try{writeFileSync(target,'synthetic metadata mutation');process.exit(2)}catch(error){if(!['EROFS','EBUSY','EACCES'].includes(error.code))process.exit(2)}
  }
  out({ type: "system", subtype: "init", session_id: sessionId })
  if (text === "CRASH") {
    process.stderr.write(`private upstream diagnostic ${token}`)
    process.exit(1)
  }
  if (text === "HANG") return
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
