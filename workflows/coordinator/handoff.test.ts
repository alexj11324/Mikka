import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { before, beforeEach, mock, test } from 'node:test'

// Run the production Workflow loop and its final durable handoff. Only the
// external model, store and Workflow transports are in memory in this unit test.
const context = new AsyncLocalStorage<{ workflowRunId: string }>()
const owner = 'synthetic-handoff-owner', bot = 'synthetic-handoff-bot'
const queue: number[] = [], replies: Array<{ request: number; holder: string }> = []
const rounds: Array<{ round: number; holder: string }> = [], starts: string[] = []
const active = new Map<string, number>(), spawned: Promise<void>[] = []
let lease: string | null = null, requests = 11, nextRun = 1, deferred = 0, firstFinished = false
let workflow: typeof import('./workflow')
const holder = () => context.getStore()!.workflowRunId
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })

const releaseLease = async (userId: string, runId: string, botId: string) => {
  assert.deepEqual([userId, botId], [owner, bot])
  if (lease === runId) lease = null
  return queue.length > 0
}
const wakeCoordinator = async (userId: string) => {
  assert.equal(userId, owner)
  if (lease) { deferred++; return }
  if (!queue.length) return
  assert.equal(firstFinished, false, 'a fresh run may start while its predecessor is still finishing')
  const id = `wrun_handoff_${nextRun++}`
  starts.push(id)
  spawned.push(context.run({ workflowRunId: id }, () => workflow.coordinatorTurn(owner, bot)))
}
mock.module('workflow', { namedExports: {
  getWorkflowMetadata: () => context.getStore(),
  getWritable: () => new WritableStream(),
  createHook: () => ({ async *[Symbol.asyncIterator]() {} }),
} })
stub('../../lib/coordinator/store.ts', { releaseLease })
stub('../../lib/coordinator/wake.ts', { wakeCoordinator })
stub('../../lib/subscription-workflow-turn.ts', { runHostedWorkflowTurn: async () => {
  const request = active.get(holder())!
  const text = `Synthetic reply ${request}`
  return { text, finishReason: 'stop', responseMessages: [{ role: 'assistant', content: text }], modelCalls: 1 }
} })
stub('./native-turn.ts', { nativeCoordinatorTurn: async () => { throw new Error('native path is outside this fixture') } })
stub('./tools.ts', { coordinatorTools: () => ({}) })
stub('./agent-kit-steps.ts', {
  beginAgentExecution: async () => null,
  // These recorded settings predate agentKitEnabled and keep the original steps.
  beginPreparedAgentExecution: async () => { throw new Error('unexpected combined preparation for recorded settings') },
  finishAgentExecution: async () => {},
  botRuntime: async () => ({ harness: 'ai_sdk' }),
})
stub('./steps.ts', {
  turnSettings: async () => ({ computerEnabled: false, mailboxEnabled: false, writeEnabled: false, switches: {}, coordinator: false, runtime: { harness: 'ai_sdk' } }),
  takeInbox: async (_owner: string, runId: string) => {
    if (lease && lease !== runId) return { held: false, added: 0 }
    lease = runId
    const request = queue.shift()
    if (request !== undefined) active.set(runId, request)
    return { held: true, added: request === undefined ? 0 : 1, handoffOnly: false, handoffMatterIds: [], telegramTargets: [], pushEvents: [] }
  },
  prepareTurn: async () => ({ mailboxTools: [], prompt: { messages: [{ role: 'user', content: `Synthetic request ${active.get(holder())}` }] } }),
  writeStreamPart: async () => {},
  appendMessages: async (_owner: string, runId: string) => {
    const request = active.get(runId)!
    replies.push({ request, holder: runId })
    // The next input arrives after this reply is stored, before its Workflow
    // finishes the round. Its producer wake is deferred by the existing lease.
    if (request < requests) { queue.push(request + 1); await wakeCoordinator(owner) }
    return replies.length
  },
  releaseLease,
  logTurnTiming: async ({ round }: { round: number }) => { rounds.push({ round, holder: holder() }) },
})

before(async () => { workflow = await import('./workflow') })
beforeEach(() => {
  queue.splice(0, queue.length, 1); replies.length = 0; rounds.length = 0; starts.length = 0; spawned.length = 0; active.clear()
  lease = null; requests = 11; nextRun = 1; deferred = 0; firstFinished = false
})

test('input queued during the tenth round is answered by a fresh run without a sweep', async () => {
  await context.run({ workflowRunId: 'wrun_original' }, () => workflow.coordinatorTurn(owner, bot))
  firstFinished = true
  await Promise.all(spawned)
  assert.deepEqual(rounds.filter(row => row.holder === 'wrun_original').map(row => row.round), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(deferred, 10, 'every producer wake, including the eleventh input, met the old active lease')
  assert.deepEqual(starts, ['wrun_handoff_1'])
  assert.deepEqual(replies.map(row => row.request), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(replies[10].holder, 'wrun_handoff_1')
  assert.deepEqual(queue, [])
  assert.equal(lease, null)
})

test('an exhausted workflow with no pending input releases its lease without starting another run', async () => {
  requests = 10
  await context.run({ workflowRunId: 'wrun_original' }, () => workflow.coordinatorTurn(owner, bot))
  assert.equal(replies.length, 10)
  assert.deepEqual(starts, [])
  assert.deepEqual(queue, [])
  assert.equal(lease, null)
})
