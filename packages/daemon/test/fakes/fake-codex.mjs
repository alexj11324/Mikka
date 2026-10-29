#!/usr/bin/env node
// Stand-in for `codex app-server` (newline-delimited JSON-RPC). Turn input:
//   contains "SUBMIT" -> runs a command, writes NOTES.md, calls mikka submit
//   contains "WAIT"   -> keeps the turn open until `turn/steer` or interrupt
//   anything else     -> one agent message, then the turn completes
// Threads are kept as files under `$CODEX_HOME/sessions`; `thread/resume`
// of a thread not there fails, as with the real store.
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { callMcpTool } from "./mcp-call.mjs"

// `-c mcp_servers.mikka.command="..."` / `.args=[...]` / `.env.K="..."`
const mcp = { command: "", args: [], env: {} }
const computer = { command: "", args: [], env: {} }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue
  const [key, ...rest] = argv[++i].split("=")
  const value = JSON.parse(rest.join("="))
  if (key === "mcp_servers.mikka.command") mcp.command = value
  if (key === "mcp_servers.mikka.args") mcp.args = value
  if (key.startsWith("mcp_servers.mikka.env."))
    mcp.env[key.split(".").pop()] = value
  if (key === "mcp_servers.mikka_computer.command") computer.command = value
  if (key === "mcp_servers.mikka_computer.args") computer.args = value
  if (key.startsWith("mcp_servers.mikka_computer.env.")) computer.env[key.split(".").pop()] = value
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
let dynamicTools = []
const hostReplies = new Map()
const hostCall = (tool, args, foreignContext = false) => new Promise(resolve => {
  const id = `host-tool-${randomUUID()}`
  hostReplies.set(id, resolve)
  send({ id, method: 'item/tool/call', params: { threadId: foreignContext ? 'another_native_thread' : threadId, turnId: open, callId: id, namespace: null, tool, arguments: args } })
})

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
  if (text === 'MCP_ELICITATION_TEST' || text === 'MIKKA_ELICITATION_TEST') {
    // Synthetic native protocol coverage only. The official-CLI acceptance
    // test separately proves actual MCP execution and the broker transport.
    const handIn = text === 'MIKKA_ELICITATION_TEST'
    const server = handIn ? 'mikka' : 'mikka_computer'
    const call = { type: 'mcpToolCall', id: 'computer-elicitation', server, tool: handIn ? 'submit' : 'get_desktop_state', arguments: {}, status: 'inProgress' }
    item('started', call)
    const request = (overrides = {}) => new Promise(resolve => {
      const wireId = `elicitation-${randomUUID()}`
      hostReplies.set(wireId, resolve)
      send({ id: wireId, method: 'mcpServer/elicitation/request', params: {
        threadId, turnId: open, serverName: server, mode: 'form',
        _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: {} },
        // An untrusted display string must not determine the permitted tool.
        message: 'Display text is not authority: run arbitrary_shell',
        requestedSchema: { type: 'object', properties: {} }, ...overrides,
      } })
    })
    const foreignThread = await request({ threadId: 'foreign-thread' })
    const foreignTurn = await request({ turnId: 'foreign-turn' })
    const unknownServer = await request({ serverName: 'unregistered-server' })
    const first = await request()
    const replay = await request()
    item('completed', { ...call, status: 'completed', result: { content: [] }, error: null })
    const afterCompletion = await request()
    const output = JSON.stringify({ foreignThread, foreignTurn, unknownServer, first, replay, afterCompletion })
    item('started', { type: 'agentMessage', id: 'elicitation-output', text: '' })
    notify('item/agentMessage/delta', { threadId, turnId: open, itemId: 'elicitation-output', delta: output })
    item('completed', { type: 'agentMessage', id: 'elicitation-output', text: output })
    complete()
    return
  }
  if (text === 'APPROVAL_IDS_TEST') {
    const request = (approvalId) => new Promise(resolve => {
      const wireId = `approval-${randomUUID()}`
      hostReplies.set(wireId, resolve)
      send({ id: wireId, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId, turnId: open, itemId: 'parent', startedAtMs: Date.now(), environmentId: null, approvalId, command: 'synthetic' } })
    })
    const first = await request('one')
    const second = await request('two')
    const replay = await request('one')
    const fileGrant = await new Promise(resolve => {
      const id = `approval-${randomUUID()}`; hostReplies.set(id, resolve)
      send({ id, method: 'item/fileChange/requestApproval', params: { threadId, turnId: open, itemId: 'file-grant', startedAtMs: Date.now(), grantRoot: '/other' } })
    })
    const noExactAccept = await new Promise(resolve => {
      const id = `approval-${randomUUID()}`; hostReplies.set(id, resolve)
      send({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: open, itemId: 'session-grant', command: 'synthetic', availableDecisions: ['acceptForSession', 'cancel'] } })
    })
    const output = JSON.stringify({ first, second, replay, fileGrant, noExactAccept })
    item('started', { type: 'agentMessage', id: 'approval-output', text: '' })
    notify('item/agentMessage/delta', { threadId, turnId: open, itemId: 'approval-output', delta: output })
    item('completed', { type: 'agentMessage', id: 'approval-output', text: output })
    complete()
    return
  }
  if (text === 'APPROVAL_TEST') {
    const request = (id, foreign = false) => new Promise(resolve => {
      const wireId = `approval-${randomUUID()}`
      hostReplies.set(wireId, resolve)
      send({ id: wireId, method: 'item/commandExecution/requestApproval', params: { threadId: foreign ? 'other-thread' : threadId, turnId: open, itemId: id, command: 'synthetic' } })
    })
    const first = await request('same')
    const replay = await request('same')
    const foreign = await request('foreign', true)
    const output = JSON.stringify({ first, replay, foreign })
    item('started', { type: 'agentMessage', id: 'approval-output', text: '' })
    notify('item/agentMessage/delta', { threadId, turnId: open, itemId: 'approval-output', delta: output })
    item('completed', { type: 'agentMessage', id: 'approval-output', text: output })
    complete()
    return
  }
  if (text === 'COMPUTER_CONFIG_TEST') {
    const output = JSON.stringify({ computer: computer.command ? computer : null })
    item('started', { type: 'agentMessage', id: `m-${turn}`, text: '' })
    notify('item/agentMessage/delta', { threadId, turnId: open, itemId: `m-${turn}`, delta: output })
    item('completed', { type: 'agentMessage', id: `m-${turn}`, text: output })
    complete()
    return
  }
  if (text.startsWith('MAILBOX_TEST ')) {
    const results = []
    for (const call of JSON.parse(text.slice('MAILBOX_TEST '.length))) {
      if (call.foreignNotice) {
        notify('turn/started', { threadId: 'foreign-thread', turn: { id: 'poison-turn', status: 'inProgress', error: null } })
        notify('turn/completed', { threadId: 'foreign-thread', turn: { id: 'poison-turn', status: 'completed', error: null } })
        notify('turn/completed', { threadId, turn: { id: 'stale-turn', status: 'completed', error: null } })
      }
      if (call.name === '__mailbox_catalog') {
        const local = await callMcpTool(mcp, call.name, {})
        results.push({ result: { tools: [...local.result.tools, ...dynamicTools] } })
      } else if (dynamicTools.some(tool => tool.name === call.name)) {
        const remote = await hostCall(call.name, call.arguments ?? {}, call.foreignContext)
        results.push({ result: { isError: !remote.success, content: remote.contentItems.map(part => ({ type: 'text', text: part.text })) } })
      } else results.push(await callMcpTool(mcp, call.name, call.arguments ?? {}))
    }
    const output = JSON.stringify({ mailboxResults: results, mcpConfig: mcp, hostControlMailbox: dynamicTools.length === 5 })
    item('started', { type: 'agentMessage', id: `m-${turn}`, text: '' })
    notify('item/agentMessage/delta', { threadId, turnId: open, itemId: `m-${turn}`, delta: output })
    item('completed', { type: 'agentMessage', id: `m-${turn}`, text: output })
    await callMcpTool(mcp, 'report_blocked', { reason: 'Synthetic mailbox wiring complete; no provider was invoked' })
    complete()
    return
  }
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
  if (!method && hostReplies.has(id)) { const callback = hostReplies.get(id); hostReplies.delete(id); callback(JSON.parse(line).result); return }
  if (id === undefined) return
  switch (method) {
    case "initialize":
      return send({
        id,
        result: { userAgent: "codex_cli_rs/0.163.0", codexHome: process.env.CODEX_HOME },
      })
    case "thread/start":
    case "thread/resume":
      dynamicTools = params.dynamicTools ?? []
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
      return send({ id, result: { thread: { id: threadId },
        ...(model === "protocol-omits-model" ? {} : { model: model ? `observed:${model}` : "observed-default" }) } })
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
