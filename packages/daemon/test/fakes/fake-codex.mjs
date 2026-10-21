#!/usr/bin/env node
// Stand-in for `codex app-server` (newline-delimited JSON-RPC). Turn input:
//   contains "SUBMIT" -> runs a command, writes NOTES.md, calls orvilo submit
//   contains "WAIT"   -> keeps the turn open until `turn/steer` or interrupt
//   anything else     -> one agent message, then the turn completes
// Threads are kept as files under `$CODEX_HOME/sessions`; `thread/resume`
// of a thread not there fails, as with the real store.
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { callMcpTool } from "./mcp-call.mjs"

// `-c mcp_servers.orvilo.command="..."` / `.args=[...]` / `.env.K="..."`
const mcp = { command: "", args: [], env: {} }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue
  const [key, ...rest] = argv[++i].split("=")
  const value = JSON.parse(rest.join("="))
  if (key === "mcp_servers.orvilo.command") mcp.command = value
  if (key === "mcp_servers.orvilo.args") mcp.args = value
  if (key.startsWith("mcp_servers.orvilo.env."))
    mcp.env[key.split(".").pop()] = value
}

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const notify = (method, params) => send({ method, params })
const sessions = join(process.env.CODEX_HOME, "sessions")
let threadId = process.env.FAKE_THREAD_ID ?? `thread-${randomUUID()}`
let turn = 0
let open = null
/** The model `thread/start` named; reported when a prompt says MODEL. */
let model = null

function item(phase, value) {
  notify(`item/${phase}`, { item: value, threadId, turnId: `turn-${turn}` })
}

function complete(status = "completed") {
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId: `turn-${turn}`,
    tokenUsage: { total: { inputTokens: 100, outputTokens: 20 } },
  })
  notify("turn/completed", {
    threadId,
    turn: { id: `turn-${turn}`, status, error: null },
  })
  open = null
}

async function runTurn(text) {
  turn++
  open = `turn-${turn}`
  notify("turn/started", {
    threadId,
    turn: { id: open, status: "inProgress", error: null },
  })
  // `MODEL` reports the model the thread was started with, so a test can
  // prove the assignment's model reached the CLI.
  const said = text.includes("MODEL")
    ? `model: ${model ?? "none"}`
    : `on it: ${text}`
  const message = { type: "agentMessage", id: `m-${turn}`, text: "" }
  item("started", message)
  notify("item/agentMessage/delta", {
    threadId,
    turnId: open,
    itemId: message.id,
    delta: said,
  })
  item("completed", { ...message, text: said })
  if (text.includes("WAIT")) return
  if (text.includes("SUBMIT")) {
    const command = {
      type: "commandExecution",
      id: `c-${turn}`,
      command: "touch NOTES.md",
      aggregatedOutput: null,
      exitCode: null,
    }
    item("started", command)
    writeFileSync("NOTES.md", "notes\n")
    item("completed", { ...command, aggregatedOutput: "", exitCode: 0 })
    item("completed", {
      type: "fileChange",
      id: `f-${turn}`,
      changes: [{ path: "NOTES.md", kind: { type: "add" }, diff: "" }],
      status: "completed",
    })
    await callMcpTool(mcp, "submit", { summary: "Wrote NOTES.md" })
  }
  complete()
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  switch (method) {
    case "initialize":
      return send({
        id,
        result: { userAgent: "fake", codexHome: process.env.CODEX_HOME },
      })
    case "thread/start":
    case "thread/resume":
      if (!params.cwd || params.sandbox !== "danger-full-access")
        return send({ id, error: { code: -1, message: "bad thread params" } })
      if (params.model) model = params.model
      if (method === "thread/resume") {
        if (!existsSync(join(sessions, `${params.threadId}.jsonl`)))
          return send({
            id,
            error: {
              code: -1,
              message: `no rollout found: ${params.threadId}`,
            },
          })
        threadId = params.threadId
      } else {
        mkdirSync(sessions, { recursive: true })
        writeFileSync(join(sessions, `${threadId}.jsonl`), "{}\n")
      }
      return send({ id, result: { thread: { id: threadId } } })
    case "turn/start":
      send({
        id,
        result: {
          turn: { id: `turn-${turn + 1}`, status: "inProgress", error: null },
        },
      })
      return runTurn(params.input[0].text)
    case "turn/steer": {
      if (params.expectedTurnId !== open)
        return send({ id, error: { code: -1, message: "no such turn" } })
      send({ id, result: {} })
      const text = params.input[0].text
      if (text.includes("SUBMIT")) {
        writeFileSync("NOTES.md", "notes\n")
        await callMcpTool(mcp, "submit", {
          summary: "Steered and wrote NOTES.md",
        })
      }
      return complete()
    }
    case "turn/interrupt":
      send({ id, result: {} })
      return complete("interrupted")
    default:
      return send({ id, error: { code: -32601, message: method } })
  }
})
