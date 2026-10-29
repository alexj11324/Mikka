#!/usr/bin/env node
// Stand-in for the Claude Code CLI the agent SDK starts (`--input-format
// stream-json --output-format stream-json`; the SDK spawns it through
// `spawnClaudeCodeProcess` when the daemon names a binary). Each user
// message is one turn:
//   contains "SUBMIT" -> writes NOTES.md, calls mikka submit via MCP
//   contains "WAIT"   -> answers, then holds the turn until the next message
//   contains "LATE"   -> (sent to a WAIT turn) its result comes out only once
//                        the next turn has handed in, as when the daemon
//                        reads stdout behind the agent
//   contains "HANG"   -> never finishes (cancel tests)
//   contains "MODEL"  -> reports the model `--model` named, so a test can
//                        prove the assignment's model reached the CLI
//   anything else     -> echoes it and ends the turn
// `--resume gone-...` stands for a session the store does not have: the
// CLI exits with an error before any output, as the real one does.
//
// The SDK also writes its control requests (`initialize`, …) on the same
// stdin, and names flags as `--flag=value`; both are handled here.
import { writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

import { callMcpTool } from "./mcp-call.mjs"

const argv = process.argv.slice(2)
const flag = (name) => {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const sessionId = flag("--session-id") ?? flag("--resume")
if (flag("--resume")?.startsWith("gone-")) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`)
  process.exit(1)
}
const mcpServers = JSON.parse(flag("--mcp-config")).mcpServers
const mcp = mcpServers.mikka
const sdkReplies = new Map()
let sdkId = 0
let sdkInitialization
const sdkCall = (method, params, server_name = 'mikka_mailbox') => new Promise(resolve => {
  const request_id = `mailbox-${++sdkId}`
  sdkReplies.set(request_id, resolve)
  out({ type: 'control_request', request_id, request: { subtype: 'mcp_message', server_name, message: { jsonrpc: '2.0', ...(method !== 'notifications/initialized' ? { id: sdkId } : {}), method, params } } })
})
const out = (event) =>
  process.stdout.write(
    `${JSON.stringify({ session_id: sessionId, ...event })}\n`
  )
let n = 0
const text = (value) =>
  out({
    type: "assistant",
    message: { id: `msg_${++n}`, content: [{ type: "text", text: value }] },
  })
const result = () =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
  })

out({ type: "system", subtype: "init", cwd: process.cwd(), ...(flag("--model") === "delayed-requested" ? {} : { model: "observed:root-model" }) })
if (flag("--resume")) text(`resumed ${sessionId}`)

let release = null
let handedIn = null
let afterHandIn = null
const lines = createInterface({ input: process.stdin })
lines.on("line", async (line) => {
  const frame = JSON.parse(line)
  if (frame.type === 'control_request') {
    if (frame.request?.subtype === 'initialize') sdkInitialization = frame.request
    out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [], agents: [], output_style: 'default' } } })
    return
  }
  if (frame.type === 'control_response') { const callback = sdkReplies.get(frame.response.request_id); if (callback) { sdkReplies.delete(frame.response.request_id); callback(frame.response.subtype === 'error' ? { error: { message: 'SDK server unavailable' } } : frame.response.response?.mcp_response ?? frame.response.response) }; return }
  // A control request (the SDK's initialize, or its shutdown) carries no
  // user text; only the prompt lines are turns.
  const asked = JSON.parse(line)?.message?.content?.[0]?.text
  if (typeof asked !== "string") return
  const message = asked
  const captureApprovals = {
    CAPTURE_SCREENSHOT_APPROVAL_TEST: ['mcp__mikka_computer__capture_screenshot', { title: 'Synthetic evidence' }],
    START_RECORDING_APPROVAL_TEST: ['mcp__mikka_computer__start_screen_recording', { title: 'Synthetic flow', maxSeconds: 5 }],
    STOP_RECORDING_APPROVAL_TEST: ['mcp__mikka_computer__stop_screen_recording', {}],
    SUBMIT_CAPTURE_APPROVAL_TEST: ['mcp__mikka__submit_capture', { title: 'Synthetic local evidence', path: 'evidence.png' }],
  }
  if (['APPROVAL_TEST', 'COMPUTER_APPROVAL_TEST', 'UNKNOWN_COMPUTER_APPROVAL_TEST'].includes(message) || Object.hasOwn(captureApprovals, message)) {
    // Fixed callback fixtures only: these never invoke an MCP computer tool.
    const toolName = captureApprovals[message]?.[0] ?? (message === 'APPROVAL_TEST' ? 'Bash'
      : message === 'COMPUTER_APPROVAL_TEST' ? 'mcp__mikka_computer__click'
      : 'mcp__mikka_computer__arbitrary_tool')
    const input = captureApprovals[message]?.[1] ?? (message === 'APPROVAL_TEST' ? { command: 'synthetic' } : { x: 1, y: 2 })
    const approval = (toolUseId) => new Promise(resolve => {
      const request_id = `approval-${++sdkId}`
      sdkReplies.set(request_id, resolve)
      out({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: toolUseId } })
    })
    const toolUseId = `synthetic-approval-${sessionId}`
    const first = await approval(toolUseId)
    const replay = await approval(toolUseId)
    text(JSON.stringify({ first, replay }))
    result()
    return
  }
  if (message === 'COMPUTER_CONFIG_TEST') {
    text(JSON.stringify({ computer: mcpServers.mikka_computer ?? null }))
    result()
    return
  }
  if (message.startsWith('MAILBOX_TEST ')) {
    const results = []
    const enabled = mcpServers.mikka_mailbox?.type === 'sdk' || sdkInitialization?.sdkMcpServers?.includes('mikka_mailbox')
    if (enabled) { await sdkCall('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-cli', version: '1' } }); await sdkCall('notifications/initialized', {}) }
    for (const call of JSON.parse(message.slice('MAILBOX_TEST '.length))) {
      if (enabled && call.name === '__mailbox_catalog') {
        const local = await callMcpTool(mcp, call.name, {})
        const remote = await sdkCall('tools/list', {})
        results.push({ result: { tools: [...local.result.tools, ...remote.result.tools] } })
      } else results.push(enabled ? await sdkCall('tools/call', { name: call.name, arguments: call.arguments ?? {} }, call.foreignContext ? 'another_run_mailbox' : 'mikka_mailbox') : await callMcpTool(mcp, call.name, call.arguments ?? {}))
    }
    text(JSON.stringify({ mailboxResults: results, mcpConfig: mcp, hostControlMailbox: Boolean(enabled) }))
    await callMcpTool(mcp, 'report_blocked', { reason: 'Synthetic mailbox wiring complete; no provider was invoked' })
    result()
    return
  }
  if (release) {
    const done = release
    release = null
    text(`steered: ${message}`)
    if (message.includes("LATE"))
      handedIn = new Promise((resolve) => (afterHandIn = resolve))
    done()
  }
  if (message.includes("HANG")) {
    text("working forever")
    return
  }
  if (message.includes("WAIT")) {
    text("waiting for you")
    await new Promise((resolve) => (release = resolve))
    await handedIn
    result()
    return
  }
  if (message.includes("SUBMIT")) {
    out({
      type: "assistant",
      message: {
        id: `msg_${++n}`,
        content: [
          {
            type: "tool_use",
            id: "toolu_w",
            name: "Write",
            input: { file_path: "NOTES.md" },
          },
        ],
      },
    })
    writeFileSync("NOTES.md", "notes\n")
    out({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_w", content: "ok" },
        ],
      },
    })
    await callMcpTool(mcp, "submit", { summary: "Wrote NOTES.md" })
    if (afterHandIn) {
      afterHandIn()
      await new Promise((resolve) => setImmediate(resolve))
    }
    text("handed in")
    result()
    return
  }
  if (message.includes("MODEL")) {
    if (message.includes("DELAYED")) {
      await new Promise(resolve => setTimeout(resolve, 50))
      out({ type: "assistant", parent_tool_use_id: null,
        message: { id: "delayed-root", model: "observed:delayed-model", content: [{ type: "text", text: "root output" }] } })
    }
    text(`model: ${flag("--model") ?? "none"}`)
    if (message.includes("SUBAGENT")) out({ type: "assistant", parent_tool_use_id: "child-tool",
      message: { id: "child-model", model: "observed:subagent-model", content: [{ type: "text", text: "child output" }] } })
    result()
    return
  }
  text(`echo: ${message}`)
  result()
})
lines.on("close", () => process.exit(0))
