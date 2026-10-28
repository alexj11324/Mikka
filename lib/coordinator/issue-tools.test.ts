import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { createIssueInput, updateIssueInput } from './issue-input'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import { AGENT_TOOL_IDS } from '@/lib/agent-kit/registry'

const created = mock.fn(async () => ({ id: 'created' }))
const updated = mock.fn(async () => ({ id: 'updated' }))
mock.module('@/workflows/coordinator/steps', { namedExports: { createIssue: created, updateIssue: updated } })
mock.module('@/workflows/coordinator/agent-kit-steps', { namedExports: {} })
mock.module('@/lib/composio-actions', { namedExports: { createComposioAITools: () => ({}), createGoogleAITools: () => ({}) } })
let registry: typeof import('@/workflows/coordinator/tools')
before(async () => { registry = await import('@/workflows/coordinator/tools') })

test('issue tools are available in the default definition and global capability registry', () => {
  for (const name of ['create_issue', 'update_issue'] as const) {
    assert.ok(DEFAULT_AGENT_DEFINITION.tools.includes(name))
    assert.ok(AGENT_TOOL_IDS.includes(name))
  }
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
  await tools.create_issue.execute!({ title: 'Requested task' }, options)
  await tools.update_issue.execute!({ issueId: '550e8400-e29b-41d4-a716-446655440000', status: 'doing' }, options)
  assert.deepEqual(created.mock.calls[0].arguments, ['owner', { title: 'Requested task' }, 'durable-call', scope, 'bot'])
  assert.deepEqual(updated.mock.calls[0].arguments, ['owner', { issueId: '550e8400-e29b-41d4-a716-446655440000', status: 'doing' }, 'durable-call', scope, 'bot'])
})
