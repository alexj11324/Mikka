#!/usr/bin/env node
// Stand-in for `codex app-server` (newline-delimited JSON-RPC). Turn input:
//   contains "SUBMIT" -> runs a command, writes NOTES.md, calls mikka submit
//   contains "WAIT"   -> keeps the turn open until `turn/steer` or interrupt
//   anything else     -> one agent message, then the turn completes
// Threads are kept as files under `$CODEX_HOME/sessions`; `thread/resume`
// of a thread not there fails, as with the real store.
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
const fixtureTrace = (event) => appendFileSync(join(process.env.CODEX_HOME, 'fixture-protocol.jsonl'), JSON.stringify(event) + '\n')
const fixtureControl = () => {
  const file = join(process.env.CODEX_HOME, 'fixture-control.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}
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
  if (text.startsWith('Mikka was restarted') && fixtureControl().mailboxOnRestart)
    text = 'MAILBOX_RESUME_TEST ' + JSON.stringify([{ name: 'mailbox_inbox', arguments: {} }])
  turn++
  open = `turn-${turn}`
  notify("turn/started", {
    threadId,
    turn: { id: open, status: "inProgress", error: null },
  })
  if (text.startsWith('FIXTURE_STRUCTURED_FAILURE')) {
    const diagnostic = JSON.stringify({ error: { code: 'insufficient_quota', message: text.includes("ECHO") ? `Your account has no remaining credit. Request: ${text}; credential: fixture-private-model-key` : "Your account has no remaining credit." } })
    writeFileSync(join(process.env.CODEX_HOME, 'provider-prompts.json'), JSON.stringify({ prompts: turn }))
    const error = { message: `unexpected status 429: ${diagnostic}`, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }
    notify('turn/completed', { threadId, turn: { id: open, status: 'failed', error } })
    open = null
    return
  }
  if (text.startsWith('PROVIDER_DIAGNOSTIC ')) {
    const scenario = JSON.parse(text.slice('PROVIDER_DIAGNOSTIC '.length))
    writeFileSync(join(process.env.CODEX_HOME, 'provider-prompts.json'), JSON.stringify({ prompts: turn }))
    if (scenario.retry) notify('error', { threadId, turnId: open, willRetry: true, error: { message: 'private retry diagnostic', codexErrorInfo: 'serverOverloaded' } })
    if (scenario.inspectRetries) item('completed', { type: 'agentMessage', id: 'retry-config', text: JSON.stringify({
      request: argv.find(arg => arg.startsWith('model_providers.mikka.request_max_retries=')),
      stream: argv.find(arg => arg.startsWith('model_providers.mikka.stream_max_retries=')),
    }) })
    if (scenario.modelText) item('completed', { type: 'agentMessage', id: 'model-text', text: scenario.modelText })
    if (scenario.toolError) item('completed', { type: 'mcpToolCall', id: 'fixture-tool', server: 'fixture', tool: 'fetch', arguments: {}, result: null, error: { message: scenario.toolError } })
    if (scenario.failure) {
      notify('error', { threadId, turnId: open, willRetry: false, error: scenario.failure })
      notify('turn/completed', { threadId, turn: { id: open, status: 'failed', error: scenario.failure } })
      open = null
    } else complete()
    return
  }
  if (text === 'TOOL_PROGRESS_TEST') {
    notify('item/commandExecution/outputDelta', { threadId: 'foreign-thread', turnId: open, delta: 'ignored' })
    notify('item/commandExecution/outputDelta', { threadId, turnId: 'stale-turn', delta: 'ignored' })
    notify('item/commandExecution/outputDelta', { threadId, turnId: open, delta: '' })
    notify('item/commandExecution/outputDelta', { threadId, turnId: open, delta: 'CI still pending' })
    complete()
    return
  }
  if (['MCP_ELICITATION_TEST', 'MIKKA_ELICITATION_TEST', 'MIKKA_CONTEXT_ELICITATION_TEST', 'MIKKA_UNKNOWN_ELICITATION_TEST', 'MIKKA_REPOSITORY_ELICITATION_TEST', 'MIKKA_ARTIFACT_ELICITATION_TEST', 'MIKKA_REPOSITORY_INSPECT_ELICITATION_TEST'].includes(text)) {
    // Synthetic native protocol coverage only. The official-CLI acceptance
    // test separately proves actual MCP execution and the broker transport.
    const handIn = text !== 'MCP_ELICITATION_TEST'
    const server = handIn ? 'mikka' : 'mikka_computer'
    const call = { type: 'mcpToolCall', id: 'computer-elicitation', server, tool: text === 'MIKKA_CONTEXT_ELICITATION_TEST' ? 'request_help' : text === 'MIKKA_UNKNOWN_ELICITATION_TEST' ? 'arbitrary_tool' : text === 'MIKKA_REPOSITORY_ELICITATION_TEST' ? 'switch_repository' : text === 'MIKKA_ARTIFACT_ELICITATION_TEST' ? 'inspect_artifact' : text === 'MIKKA_REPOSITORY_INSPECT_ELICITATION_TEST' ? 'inspect_repository' : handIn ? 'submit' : 'get_desktop_state', arguments: {}, status: 'inProgress' }
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
    const output = JSON.stringify({ foreignThread, foreignTurn, unknownServer, first, replay, afterCompletion,
      ...(text === 'MIKKA_REPOSITORY_INSPECT_ELICITATION_TEST' ? { shellTool: argv.find(arg => arg.startsWith('features.shell_tool=')) } : {}),
    })
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
  // Scripted macOS acceptance: the real proxy is the computer config the
  // daemon injected; every call is a real MCP round trip, and image bytes are
  // reported by size only so no screenshot enters the transcript.
  if (text.startsWith('COMPUTER_ACTIONS_TEST ')) {
    const calls = JSON.parse(text.slice('COMPUTER_ACTIONS_TEST '.length))
    const results = []
    for (const call of calls) {
      const reply = await callMcpTool(computer, call.name, call.arguments ?? {})
      const result = reply?.result ?? reply
      const image = Array.isArray(result?.content)
        ? result.content.find(part => part?.type === 'image' && typeof part.data === 'string')
        : null
      results.push({
        name: call.name,
        isError: result?.isError === true,
        imageBytes: image ? Buffer.from(image.data, 'base64').length : 0,
        width: result?.structuredContent?.screenshot_width ?? null,
        height: result?.structuredContent?.screenshot_height ?? null,
      })
    }
    const output = JSON.stringify({ computerResults: results })
    item('started', { type: 'agentMessage', id: `m-${turn}`, text: '' })
    notify('item/agentMessage/delta', { threadId, turnId: open, itemId: `m-${turn}`, delta: output })
    item('completed', { type: 'agentMessage', id: `m-${turn}`, text: output })
    complete()
    return
  }
  if (text.startsWith('MAILBOX_TEST ') || text.startsWith('MAILBOX_RESUME_TEST ')) {
    const resumeFixture = text.startsWith('MAILBOX_RESUME_TEST ')
    const results = []
    for (const call of JSON.parse(text.slice(resumeFixture ? 'MAILBOX_RESUME_TEST '.length : 'MAILBOX_TEST '.length))) {
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
    if (!resumeFixture) await callMcpTool(mcp, 'report_blocked', { reason: 'Synthetic mailbox wiring complete; no provider was invoked' })
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
        result: { userAgent: fixtureControl().userAgent ?? "codex_cli_rs/0.163.0", codexHome: process.env.CODEX_HOME },
      })
    case "thread/start":
    case "thread/resume": {
      fixtureTrace({ method, dynamicToolsPresent: Object.hasOwn(params, 'dynamicTools') })
      // Runs ask nothing and use no Codex sandbox (decision 2026-11-01-2335).
      if (!params.cwd || params.sandbox !== "danger-full-access" || params.approvalPolicy !== "never")
        return send({ id, error: { code: -1, message: "bad thread params" } })
      if (params.model) model = params.model
      if (method === "thread/resume") {
        const controls = fixtureControl()
        if (controls.refuseResume) return send({ id, error: { code: -1, message: 'Synthetic resume refusal' } })
        if (!existsSync(join(sessions, `${params.threadId}.jsonl`)))
          return send({
            id,
            error: {
              code: -1,
              message: `no rollout found: ${params.threadId}`,
            },
          })
        threadId = params.threadId
        // Official 0.163.0 restores the catalogue from the rollout. Its resume
        // schema has no dynamicTools: an extra request field cannot replace it.
        const header = JSON.parse(readFileSync(join(sessions, `${threadId}.jsonl`), 'utf8').split('\n')[0])
        dynamicTools = header.payload?.dynamic_tools ?? []
        if (controls.staleDuringResume) {
          open = 'previous-turn'
          fixtureTrace({ staleDuringResume: await hostCall('mailbox_inbox', {}) })
          open = null
        }
        if (controls.differentThread) return send({ id, result: { thread: { id: 'different-thread', path: join(sessions, `${threadId}.jsonl`) } } })
      } else {
        dynamicTools = params.dynamicTools ?? []
        mkdirSync(sessions, { recursive: true })
        writeFileSync(join(sessions, `${threadId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: threadId, dynamic_tools: dynamicTools } }) + '\n')
      }
      return send({ id, result: { thread: { id: threadId, ...(fixtureControl().omitRolloutPath ? {} : { path: join(sessions, `${threadId}.jsonl`) }) },
        ...(model === "protocol-omits-model" ? {} : { model: model ? `observed:${model}` : "observed-default" }) } })
    }
    case "turn/start":
      fixtureTrace({ method })
      if (params.input[0].text.startsWith('PROVIDER_DIAGNOSTIC ')) {
        const scenario = JSON.parse(params.input[0].text.slice('PROVIDER_DIAGNOSTIC '.length))
        if (scenario.rpcError) {
          turn++
          writeFileSync(join(process.env.CODEX_HOME, 'provider-prompts.json'), JSON.stringify({ prompts: turn }))
          return send({ id, error: scenario.rpcError })
        }
      }
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

