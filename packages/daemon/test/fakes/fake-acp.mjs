#!/usr/bin/env node
// Stand-in for `agent acp` (Cursor) built on the ACP SDK. Prompt text:
//   contains "SUBMIT" -> asks permission, writes NOTES.md, calls mikka submit
//   contains "HANG"   -> runs until `session/cancel`
//   contains "MODEL"  -> reports the model `--model` named, so a test can
//                        prove the assignment's model reached the CLI
//   anything else     -> one message chunk, end_turn
// Every prompt is echoed first ("heard: ..."). Chats are kept as files
// under `$CURSOR_DATA_DIR/chats`; `session/load` of one not there fails.
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"

import * as acp from "@agentclientprotocol/sdk"

import { callMcpTool } from "./mcp-call.mjs"

const sessions = new Map()
const chats = join(process.env.CURSOR_DATA_DIR, "chats")
const argv = process.argv.slice(2)

new acp.AgentSideConnection(
  (conn) => {
    const say = (sessionId, text) =>
      conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      })
    return {
      async initialize() {
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
        }
      },
      async newSession(params) {
        const sessionId = `cursor-${randomUUID()}`
        sessions.set(sessionId, { mcp: params.mcpServers, abort: null })
        mkdirSync(chats, { recursive: true })
        writeFileSync(join(chats, sessionId), "")
        return { sessionId }
      },
      async loadSession(params) {
        if (!existsSync(join(chats, params.sessionId)))
          throw acp.RequestError.resourceNotFound(params.sessionId)
        sessions.set(params.sessionId, { mcp: params.mcpServers, abort: null })
        // History replay: the client must not show it again.
        await say(params.sessionId, "REPLAYED HISTORY")
        return {}
      },
      async authenticate() {
        return {}
      },
      async cancel(params) {
        sessions.get(params.sessionId)?.abort?.()
      },
      async prompt(params) {
        const session = sessions.get(params.sessionId)
        const text = params.prompt.map((p) => p.text ?? "").join("\n")
        if (text.includes('COMPUTER_CONFIG_TEST')) {
          const server = session.mcp.find(s => s.name === 'mikka_computer')
          await say(params.sessionId, JSON.stringify({ computer: server ? { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(e => [e.name, e.value])) } : null }))
          return { stopReason: 'end_turn' }
        }
        await say(params.sessionId, `heard: ${text} `)
        await say(params.sessionId, "thinking ")
        await say(params.sessionId, "about it")
        if (text.includes("MODEL")) {
          const at = argv.indexOf("--model")
          await say(
            params.sessionId,
            `model: ${at >= 0 ? argv[at + 1] : "none"}`
          )
          return { stopReason: "end_turn" }
        }
        if (text.includes("HANG")) {
          await new Promise((resolve) => (session.abort = resolve))
          return { stopReason: "cancelled" }
        }
        if (text.includes("SUBMIT")) {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "t1",
              title: "touch NOTES.md",
              kind: "execute",
              status: "pending",
              rawInput: { command: "touch NOTES.md" },
            },
          })
          const permission = await conn.requestPermission({
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: "t1",
              title: "touch NOTES.md",
              kind: "execute",
            },
            options: [
              { optionId: "no", name: "Reject", kind: "reject_once" },
              { optionId: "yes", name: "Allow", kind: "allow_once" },
            ],
          })
          if (permission.outcome.optionId !== "yes") throw new Error("denied")
          writeFileSync("NOTES.md", "notes\n")
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "t1",
              status: "completed",
              rawOutput: { exitCode: 0 },
            },
          })
          const server = session.mcp.find((s) => s.name === "mikka")
          await callMcpTool(
            {
              command: server.command,
              args: server.args,
              env: Object.fromEntries(server.env.map((e) => [e.name, e.value])),
            },
            "submit",
            { summary: "Wrote NOTES.md" }
          )
        }
        return {
          stopReason: "end_turn",
          usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 },
        }
      },
    }
  },
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin)
  )
)
