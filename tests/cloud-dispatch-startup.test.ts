import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

const owner = 'synthetic-owner', botId = '10000000-0000-4000-8000-000000000001'
const issueId = '10000000-0000-4000-8000-000000000002', runId = '10000000-0000-4000-8000-000000000003'
const calls: string[] = []
let failure: 'machine' | 'lifecycle' | null = null
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
const unused = () => { throw new Error('Unexpected side effect in startup fixture') }
stub('../lib/auth.ts', { auth: { api: {} } })
stub('../lib/cloud-computer-flag.ts', { cloudComputerRunsEnabled: () => true, cloudComputerTasksEnabled: () => true, byosEnabled: () => true, byosEnrollmentEnabled: () => true })
stub('../lib/db/index.ts', { db: {}, pool: { query: async () => ({ rows: [{ workspaceId: 'workspace', agentId: 'agent', repoId: 'repo', deviceId: 'device' }] }) }, withDatabaseClient: unused, withDatabaseTransaction: unused })
stub('../lib/agent-runs.ts', { queueRun: unused, queueFactoryRun: unused, addRunMessage: unused, readRun: unused, requestRunStop: unused, visibleRuns: unused })
stub('../lib/issue-access.ts', { issueForUser: async () => ({ id: issueId, title: 'Task', content: { type: 'doc' } }), requireUser: async () => {} })
stub('../lib/subscription-runtime.ts', { authorizeSubscriptionWorkspace: async () => {}, subscriptionRuntime: {} })
stub('../lib/computer/queue-run.ts', { queueCloudRun: async () => { calls.push('queue'); return { runId } } })
stub('../lib/cloud-computer/thread-machines.ts', {
  ensureThreadMachine: async () => { calls.push('machine'); if (failure === 'machine') throw new Error('Synthetic machine failure') },
  threadMachineAction: async (_pool: unknown, actor: unknown, id: string, action: string) => {
    assert.deepEqual(actor, { userId: owner, workspaceId: 'workspace' }); assert.equal(id, runId); assert.equal(action, 'end'); calls.push('end')
  },
})
mock.module('workflow/api', { namedExports: { start: async () => { calls.push('lifecycle'); if (failure === 'lifecycle') throw new Error('Synthetic workflow launch failure'); return { runId: 'workflow' } } } })
stub('../workflows/thread-machine/workflow.ts', { threadMachineLifecycle: async () => {} })
let dispatch: typeof import('../workflows/coordinator/steps')['dispatchComputerTask']
before(async () => { dispatch = (await import('../workflows/coordinator/steps')).dispatchComputerTask })
beforeEach(() => { calls.length = 0; failure = null })

test('cloud startup succeeds only after both machine preparation and lifecycle launch', async () => {
  const result = await dispatch(owner, { botId, issueId, harness: 'codex', model: 'synthetic-model' }, 'synthetic-call')
  assert.ok('runId' in result)
  assert.deepEqual(calls, ['queue', 'machine', 'lifecycle'])
})

for (const stage of ['machine', 'lifecycle'] as const) test(`a ${stage} failure ends the queued cloud run before returning an unavailable result`, async () => {
  failure = stage
  assert.deepEqual(await dispatch(owner, { botId, issueId, harness: 'codex', model: 'synthetic-model' }, 'synthetic-call'), { error: 'cloudComputerUnavailable' })
  assert.deepEqual(calls, ['queue', 'machine', ...(stage === 'lifecycle' ? ['lifecycle'] : []), 'end'])
})
