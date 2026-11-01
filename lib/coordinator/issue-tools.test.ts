import assert from 'node:assert/strict'
import { afterEach, before, beforeEach, mock, test } from 'node:test'
import { createIssueInput, updateIssueInput } from './issue-input'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import { AGENT_TOOL_IDS, SCHEDULE_TOOL_IDS } from '@/lib/agent-kit/registry'
import { issueMutationsEnabled } from './issue-tools-enabled'
import { COORDINATOR_INSTRUCTIONS } from './instructions'
/** The person's Coordinator: an ordinary bot row, marked as the Coordinator. */
const COORDINATOR_BOT = '00000000-0000-4000-8000-0000000c0de1'

const created = mock.fn(async () => ({ id: 'created' }))
const updated = mock.fn(async () => ({ id: 'updated' }))
const dispatched = mock.fn(async () => ({ runId: 'queued' }))
const proposed = mock.fn(async () => ({ status: 'awaiting_approval' }))
const readIssue = mock.fn(async (..._args: unknown[]) => ({ id: 'read-issue' }))
const scheduled = mock.fn(async (..._args: unknown[]) => ({ id: 'schedule' }))
mock.module('@/workflows/coordinator/steps', { namedExports: { createIssue: created, updateIssue: updated, dispatchRun: dispatched, proposeRepositoryPushApproval: proposed, getIssue: readIssue, scheduleCommand: scheduled } })
mock.module('@/workflows/coordinator/agent-kit-steps', { namedExports: {} })
mock.module('@/lib/composio-actions', { namedExports: { createComposioAITools: () => ({}), createGoogleAITools: () => ({}) } })
let registry: typeof import('@/workflows/coordinator/tools')
before(async () => { registry = await import('@/workflows/coordinator/tools') })
const previousFlag = process.env.MIKKA_ISSUE_TOOLS_ENABLED
beforeEach(() => { process.env.MIKKA_ISSUE_TOOLS_ENABLED = '1' })
afterEach(() => { if (previousFlag === undefined) delete process.env.MIKKA_ISSUE_TOOLS_ENABLED; else process.env.MIKKA_ISSUE_TOOLS_ENABLED = previousFlag })

test('issue tools default on; only an explicit kill switch turns them off', () => {
  assert.equal(issueMutationsEnabled({}), true)
  assert.equal(issueMutationsEnabled({ MIKKA_ISSUE_TOOLS_ENABLED: '1' }), true)
  assert.equal(issueMutationsEnabled({ MIKKA_ISSUE_TOOLS_ENABLED: '0' }), false)
  assert.equal(issueMutationsEnabled({ MIKKA_ISSUE_TOOLS_ENABLED: 'true' }), false)
  delete process.env.MIKKA_ISSUE_TOOLS_ENABLED
  const unset = registry.createCoordinatorRegistry('owner', COORDINATOR_BOT, undefined, { coordinator: true })
  assert.ok(unset.create_issue)
  assert.ok(unset.update_issue)
})

test('the kill switch removes the tools and never widens a frozen execution grant', () => {
  process.env.MIKKA_ISSUE_TOOLS_ENABLED = '0'
  const disabled = registry.createCoordinatorRegistry('owner', COORDINATOR_BOT, undefined, { coordinator: true })
  assert.equal(disabled.create_issue, undefined)
  assert.equal(disabled.update_issue, undefined)
  assert.doesNotMatch(COORDINATOR_INSTRUCTIONS, /When task mutation tools are available|Respect the machine selected in a new-task request/)
  type Execution = NonNullable<NonNullable<Parameters<typeof registry.coordinatorTools>[3]>['execution']>
  const executionFor = (effectiveTools: string[]) => ({ id: 'execution', snapshot: { effectiveTools } }) as unknown as Execution
  assert.deepEqual(Object.keys(registry.coordinatorTools('owner', COORDINATOR_BOT, undefined, { coordinator: true,  execution: executionFor(['create_issue', 'get_issue']) })), ['get_issue'])
  process.env.MIKKA_ISSUE_TOOLS_ENABLED = '1'
  assert.deepEqual(Object.keys(registry.coordinatorTools('owner', COORDINATOR_BOT, undefined, { coordinator: true,  execution: executionFor(['get_issue']) })), ['get_issue'])
  assert.throws(() => registry.coordinatorTools('owner', COORDINATOR_BOT, undefined, { coordinator: true,  execution: executionFor(['unregistered_tool']) }))
})

test('issue tools are available in the default definition and global capability registry', () => {
  for (const name of ['create_issue', 'update_issue'] as const) {
    assert.ok(DEFAULT_AGENT_DEFINITION.tools.includes(name))
    assert.ok(AGENT_TOOL_IDS.includes(name))
  }
})

test('scheduled reads cannot request write tools and retain their trusted read scope', async () => {
  const scope = { holder: 'holder', turnId: 'turn', callId: 'scope-call' }
  const tools = registry.createCoordinatorRegistry('owner', 'bot', scope, { readOnly: true, readToolIds: ['get_issue', 'create_issue', 'stop_run'] })
  assert.deepEqual(Object.keys(tools), ['get_issue'])
  const input = { issueId: '550e8400-e29b-41d4-a716-446655440000' }
  await tools.get_issue!.execute!(input, { toolCallId: 'scheduled-read', messages: [], context: {} })
  assert.deepEqual(readIssue.mock.calls.at(-1)!.arguments, ['owner', input, scope, 'bot'])
})

test('scheduled read restrictions narrow a frozen grant before instrumentation', () => {
  type Execution = NonNullable<NonNullable<Parameters<typeof registry.coordinatorTools>[3]>['execution']>
  const execution = { id: 'execution', snapshot: { effectiveTools: ['create_issue', 'dispatch_run', 'get_issue', 'web_search', 'schedule_create'] } } as unknown as Execution
  const tools = registry.coordinatorTools('owner', COORDINATOR_BOT, undefined, { coordinator: true,  execution, readOnly: true, readToolIds: ['get_issue', 'create_issue'] })
  assert.deepEqual(Object.keys(tools), ['get_issue'])
})

test('schedule tools use the host source event and SDK call identity', async () => {
  const sourceEventId = 'b4000000-0000-4000-8000-000000000004'
  const scope = { holder: 'holder', turnId: 'turn', callId: 'scope-call' }
  const tools = registry.createCoordinatorRegistry('owner', 'bot', scope, { sourceEventId })
  for (const name of SCHEDULE_TOOL_IDS) {
    assert.ok(DEFAULT_AGENT_DEFINITION.tools.includes(name))
    assert.ok((AGENT_TOOL_IDS as readonly string[]).includes(name))
    assert.ok(tools[name])
  }
  const definition = {
    title: 'Read the task', timezone: 'UTC', timing: { kind: 'once', at: '2030-01-01T09:00:00Z' },
    task: { kind: 'reminder', text: 'Read the task' }, misfire: 'catch_up_once', maxLatenessMinutes: 5,
  }
  const schema = tools.schedule_create!.inputSchema as { safeParse(input: unknown): { success: boolean } }
  assert.equal(schema.safeParse({ definition, sourceEventId: 'forged' }).success, false)
  await tools.schedule_create!.execute!({ definition }, { toolCallId: 'sdk-schedule', messages: [], context: {} })
  assert.deepEqual(scheduled.mock.calls.at(-1)!.arguments, ['owner', 'bot', sourceEventId, { action: 'create', requestId: 'sdk-schedule', definition }, scope])
})

test('schemas allow a human assignee and reject execution identities and workspace DB mutations', () => {
  assert.ok(createIssueInput.safeParse({ title: 'Review login', assigneeUserId: 'person' }).success)
  assert.ok(updateIssueInput.safeParse({ issueId: '550e8400-e29b-41d4-a716-446655440000', status: 'done', assigneeUserId: null }).success)
  assert.equal(createIssueInput.safeParse({ title: 'Task', assigneeAgentId: 'worker' }).success, false)
  assert.equal(createIssueInput.safeParse({ title: 'Task', projectId: '550e8400-e29b-41d4-a716-446655440000' }).success, false)
  assert.equal(createIssueInput.safeParse({ title: 'Task', status: 'invented' }).success, false)
})

test('mutations preserve the host user, Bot and scope and forward the SDK tool call id', async () => {
  const scope = { holder: 'holder', turnId: 'turn', callId: 'scope-call' }
  const tools = registry.createCoordinatorRegistry('owner', 'bot', scope)
  const options = { toolCallId: 'durable-call', messages: [], context: {} }
  await tools.create_issue!.execute!({ title: 'Requested task' }, options)
  await tools.update_issue!.execute!({ issueId: '550e8400-e29b-41d4-a716-446655440000', status: 'doing' }, options)
  assert.deepEqual(created.mock.calls[0].arguments, ['owner', { title: 'Requested task' }, 'durable-call', scope, 'bot'])
  assert.deepEqual(updated.mock.calls[0].arguments, ['owner', { issueId: '550e8400-e29b-41d4-a716-446655440000', status: 'doing' }, 'durable-call', scope, 'bot'])
})

test('create tool forwards only the host-provided request event, never a model argument', async () => {
  const eventId = 'b4000000-0000-4000-8000-000000000004'
  const tools = registry.createCoordinatorRegistry('owner', COORDINATOR_BOT, undefined, { coordinator: true,  taskEventId: eventId })
  const options = { toolCallId: 'event-call', messages: [], context: {} }
  assert.equal(createIssueInput.safeParse({ title: 'Task', taskEventId: 'forged' }).success, false)
  await tools.create_issue!.execute!({ title: 'Task' }, options)
  assert.deepEqual(created.mock.calls.at(-1)!.arguments, ['owner', { title: 'Task' }, 'event-call', undefined, COORDINATOR_BOT, eventId])
})

test('dispatch uses the same host event as task creation and exposes no event argument to the model', async () => {
  const eventId = 'b4000000-0000-4000-8000-000000000004'
  const tools = registry.createCoordinatorRegistry('owner', COORDINATOR_BOT, undefined, { coordinator: true,  taskEventId: eventId })
  const input = { issueId: 'b4000000-0000-4000-8000-000000000005', agentId: 'b4000000-0000-4000-8000-000000000006', repo: 'example/repository' }
  await tools.dispatch_run!.execute!(input, { toolCallId: 'dispatch', messages: [], context: {} })
  assert.deepEqual(dispatched.mock.calls.at(-1)!.arguments, ['owner', {...input,requestKey:'dispatch:dispatch'}, undefined, COORDINATOR_BOT, undefined, eventId])
  const request = tools.request_repository_push_approval!
  const schema = request.inputSchema as { safeParse(input: unknown): { success: boolean } }
  assert.equal(schema.safeParse({ repo: input.repo, taskEventId: 'forged' }).success, false)
  await request.execute!({ repo: input.repo }, { toolCallId: 'approval', messages: [], context: {} })
  assert.deepEqual(proposed.mock.calls.at(-1)!.arguments, ['owner', { repo: input.repo }, undefined, { eventId, botId: COORDINATOR_BOT }])
  const resumed = registry.createCoordinatorRegistry('owner', COORDINATOR_BOT, undefined, { coordinator: true,  taskEventId: eventId, approvedRepositoryKey: 'v2:github.com/example/repository' })
  await resumed.dispatch_run!.execute!(input, { toolCallId: 'resumed-dispatch', messages: [], context: {} })
  assert.deepEqual(dispatched.mock.calls.at(-1)!.arguments, ['owner', {...input,requestKey:'dispatch:resumed-dispatch'}, undefined, COORDINATOR_BOT, undefined, eventId, 'v2:github.com/example/repository'])
})
