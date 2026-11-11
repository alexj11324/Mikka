import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelMessage } from 'ai'
import { chatItems, type ChatTool } from './context'
import { toolSummary } from './tool-activity'
import { coordinatorTextStream } from './stream-response'
import type { CoordinatorStreamEvent, CoordinatorWorkflowStreamPart } from './stream'
import { coordinatorStreamReply, readCoordinatorStream, type CoordinatorLiveReply } from '@/tests/support/legacy-coordinator-stream'
import { fingerprint } from '../credentials/fingerprint'
import { CodedError } from '@mikka/protocol/coded-error'

type Metadata = { target?: string; displayName?: string; errorCode?: string; errorDetail?: string }
const at = new Date('2026-11-05T12:00:00Z')

function stored(name: string, input: unknown, value: unknown, outputType = 'json'): ChatTool & Metadata {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call', toolName: name, input }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: name, output: { type: outputType, value } }] },
  ] as ModelMessage[]
  return chatItems(messages.map((message, index) => ({ position: index + 1, createdAt: at, message })))[0].activity!.tools[0]
}

async function streamed(name: string, input: unknown, output: unknown, secrets: ReturnType<typeof fingerprint>[] = [], thrown = false) {
  const parts = [
    { type: 'coordinator-turn-start', id: 'turn', quietEligible: false },
    { type: 'tool-call', toolCallId: 'call', toolName: name, input },
    thrown ? { type: 'tool-error', toolCallId: 'call', toolName: name, input, error: output } : { type: 'tool-result', toolCallId: 'call', toolName: name, input, output },
    { type: 'coordinator-turn-committed', id: 'turn', through: 2, quiet: false },
  ] as CoordinatorWorkflowStreamPart[]
  const source = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } })
  const events: CoordinatorStreamEvent[] = []
  for await (const event of source.pipeThrough(coordinatorTextStream('owner', secrets))) events.push(event)
  // Exercise the public JSON stream decoder as well as the server emitter.
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n')
  let replies: CoordinatorLiveReply[] = []
  await readCoordinatorStream(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }), event => { replies = coordinatorStreamReply(replies, event) })
  return { events, tool: replies[0].tools![0] as ChatTool & Metadata }
}

test('a full tool result keeps its failure code after the visible output has been cut', async () => {
  const input = { taskId: 'existing-task', title: 'ALEX-45' }
  const result = { a: 'x'.repeat(350), error: 'factoryNotFound' }
  const tool = stored('get_factory_task', input, result)
  assert.equal(tool.state, 'error')
  assert.equal(tool.errorCode, 'factoryNotFound')
  assert.equal(tool.target, 'ALEX-45')
  assert.equal(tool.displayName, 'Get factory task')
  assert.equal(tool.output!.includes('factoryNotFound'), false, 'the failure does not depend on the cut preview')
  assert.deepEqual(toolSummary([tool]), { parts: [], failed: 1, failedNames: ['get_factory_task'] })
  const live = await streamed('get_factory_task', input, result)
  assert.equal(live.tool.state, tool.state)
  assert.equal(live.tool.errorCode, tool.errorCode)
  assert.equal(live.tool.target, tool.target)
  assert.equal(live.tool.displayName, tool.displayName)
})

test('explicit failure receipts retain code and detail without treating listed item failures as the call failure', async () => {
  const rejected = { ok: false, code: 'worker_spawn_failed', detail: 'cli_not_installed', a: 'x'.repeat(300) }
  for (const tool of [stored('dispatch_run', {}, rejected), (await streamed('dispatch_run', {}, rejected)).tool]) {
    assert.equal(tool.state, 'error')
    assert.equal(tool.errorCode, 'worker_spawn_failed')
    assert.equal(tool.errorDetail, 'cli_not_installed')
  }
  for (const output of [{ items: [{ error: 'factoryNotFound', ok: false }] }, { error: '' }, { error: null }, { error: false }, []]) {
    assert.equal(stored('list_issues', {}, output).state, 'done')
    assert.equal((await streamed('list_issues', {}, output)).tool.state, 'done')
  }
  const mcp = { isError: true, structuredContent: { error: 'repositoryNotFound', detail: 'not_visible_to_token' } }
  assert.equal(stored('github_call', { name: 'pull_request_read' }, mcp).errorCode, 'repositoryNotFound')
  assert.equal((await streamed('github_call', { name: 'pull_request_read' }, mcp)).tool.errorDetail, 'not_visible_to_token')
})

test('targets and dynamic call names come from the full input rather than the preview', async () => {
  const query = 'find the latest deployment'
  const input = { a: 'padding '.repeat(80), query }
  assert.equal(stored('web_search', input, {}).target, query)
  assert.equal(stored('web_search', input, {}).input!.includes(query), false)
  assert.equal((await streamed('web_search', input, {})).tool.target, query)
  for (const name of ['github_call', 'call_personal_mcp_tool']) {
    const request = { name: 'pull_request_read', arguments: { a: 'padding '.repeat(80), owner: 'alexj11324', repo: 'Mikka' } }
    const prefix = name === 'github_call' ? 'GitHub' : 'MCP'
    for (const tool of [stored(name, request, {}), (await streamed(name, request, {})).tool]) {
      assert.equal(tool.target, 'alexj11324/Mikka')
      assert.equal(tool.displayName, `${prefix} · Pull request read`)
    }
  }
})

test('bounded metadata checks the complete value for saved secrets before truncating', async () => {
  const before = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-chat-tool-metadata-secret'
  try {
    const secret = 'SYNTHETIC-SAVED-SECRET'
    const query = 'q'.repeat(150) + secret + ' tail'
    const events = (await streamed('web_search', { query }, {}, [fingerprint('owner', secret)])).events
    const first = events.find((event): event is Extract<CoordinatorStreamEvent, { type: 'tool' }> => event.type === 'tool') as Extract<CoordinatorStreamEvent, { type: 'tool' }> & Metadata
    assert.equal(first.target, undefined)
    assert.equal(JSON.stringify(events).includes('SYNTHETIC'), false)
  } finally {
    if (before === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = before
  }
})

test('thrown coded errors retain their code and detail without exposing their cause', async () => {
  const error = new CodedError('worker_spawn_failed', { detail: 'cli_not_installed', cause: new Error('private provider stderr') })
  const history = stored('dispatch_run', {}, error.message, 'error-text')
  const live = (await streamed('dispatch_run', {}, error, [], true)).tool
  for (const tool of [history, live]) {
    assert.equal(tool.state, 'error')
    assert.equal(tool.errorCode, 'worker_spawn_failed')
    assert.equal(tool.errorDetail, 'cli_not_installed')
  }
  assert.equal(JSON.stringify(live).includes('private provider stderr'), false)
  assert.equal(live.output, undefined)
})

test('a code-shaped saved secret is omitted from error metadata without hiding the failure', async () => {
  const before = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-chat-tool-metadata-secret'
  try {
    const secret = 'SYNTHETIC-SAVED-ERROR-SECRET'
    const live = await streamed('get_factory_task', {}, { error: secret }, [fingerprint('owner', secret)])
    assert.equal(live.tool.state, 'error')
    assert.equal(live.tool.errorCode, undefined)
    assert.equal(JSON.stringify(live).includes(secret), false)
  } finally {
    if (before === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = before
  }
})
