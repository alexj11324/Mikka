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
const mcp = JSON.parse(flag("--mcp-config")).mcpServers.mikka
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
  // A control request (the SDK's initialize, or its shutdown) carries no
  // user text; only the prompt lines are turns.
  const asked = JSON.parse(line)?.message?.content?.[0]?.text
  if (typeof asked !== "string") return
  const message = asked
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
