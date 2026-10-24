#!/usr/bin/env node
// Synthetic native-auth process only; no provider/network requests.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const flag = (key) => {
  const inline = args.find((arg) => arg.startsWith(`${key}=`))
  if (inline) return inline.slice(key.length + 1)
  return args[args.indexOf(key) + 1]
}
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
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
lines.on("line", (line) => {
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
