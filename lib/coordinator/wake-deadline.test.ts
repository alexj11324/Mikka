import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { deliverWake, type DeadlineWakeClaim, type WakeDeadlineResult, type WakeDeadlineTicket } from './wake-recovery'

const scope = { userId: 'synthetic-wake-owner', botId: 'c0000000-0000-4000-8000-0000000c0de1' }
const eventId = 'e0000000-0000-4000-8000-000000000001'
const leasedAt = '2026-11-04T12:02:00.000Z', retryAt = '2026-11-04T12:01:00.000Z'
const makeTicket = (attempt = 1, at = leasedAt, leaseUntil: string | null = at): WakeDeadlineTicket => ({
  ...scope, at, events: [{ id: eventId, attempt, nextWakeAt: at, leaseUntil }],
})
const makeClaim = (attempt = 1): DeadlineWakeClaim => ({ ...scope, ids: [eventId], attempt, leaseUntil: new Date(leasedAt), ticket: makeTicket(attempt) })
let trace: string[] = [], errors: unknown[][] = [], claimed: DeadlineWakeClaim | null = makeClaim()
let resumed: WakeDeadlineResult = { kind: 'obsolete' }
let turnThrows = false, deadlineThrows = false, claimThrows = false, failureThrows = false
let failureGate: Promise<void> | undefined
let defaultAvailable = true, ownModelReady = true
let dueScopes: Array<typeof scope> = []
const readinessCalls: Array<[string, string | null]> = []
const originalVercel = process.env.VERCEL, originalConsole = console.error
const coordinatorTurn = () => {}, deadlineWorkflow = () => {}
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../db/index.ts', { pool: {}, db: {} })
stub('../workspace-db.ts', { workspacePool: {} })
stub('../attention/store.ts', { releaseAttention: async () => {} })
stub('./coordinator-bot.ts', { coordinatorBot: async () => ({ botId: scope.botId }) })
stub('./store.ts', { wakingChats: async () => [scope.botId], untriagedEvents: async () => [],
  claimTriageAttempt: async () => null, completeTriageAttempt: async () => false, setEventTier: async () => false, hasWakingEvents: async () => true })
stub('./decide.ts', { invokeDecision: async () => { throw new Error('Model calls are forbidden in this fixture') } })
stub('./triage-batch.ts', { TRIAGE_BATCH_BUDGET_MS: 1000, runTriageBatch: async () => { trace.push('triage'); return { pending: [] } } })
stub('./run-completion-delivery.ts', { deliverRunCompletion: async () => {} })
stub('./push-decision.ts', { pushByDecision: async () => {} })
stub('../run-test-fixture.ts', { runTestFixture: () => undefined })
stub('../default-model.ts', { defaultModelAvailable: async () => defaultAvailable })
stub('./model-ready.ts', { botModelReady: async (owner: string, bot: string | null) => { readinessCalls.push([owner, bot]); return ownModelReady } })
stub('./interrupted-turns.ts', { recoverInterruptedTurns: async () => ({ recovered: 0 }) })
stub('../abuse/context.ts', { hostedBillingScope: { run: (_scope: unknown, run: () => unknown) => run() } })
stub('../execution-settings.ts', { executionWorkspace: async () => 'synthetic-workspace' })
stub('../../workflows/coordinator/workflow.ts', { coordinatorTurn })
stub('../../workflows/coordinator-wake-recovery/workflow.ts', { coordinatorWakeDeadline: deadlineWorkflow })
stub('./wake-recovery.ts', { deliverWake, createWakeRecovery: () => ({
  claim: async () => { trace.push('claim'); if (claimThrows) throw Object.assign(new Error('private database text'), { code: 'P0001' }); trace.push('claim-committed'); return claimed },
  resume: async (ticket: WakeDeadlineTicket) => { assert.deepEqual(ticket, makeTicket()); trace.push('resume'); return resumed },
  failed: async () => { trace.push('failed-write'); if (failureGate) await failureGate; if (failureThrows) throw new Error('private database text'); trace.push('failed-committed'); return makeTicket(1, retryAt, null) },
  due: async () => dueScopes, exhausted: async () => 0, replay: async () => false,
}) })
mock.module('workflow/api', { namedExports: { start: async (workflow: unknown, args: unknown[]) => {
  if (workflow === coordinatorTurn) { assert.deepEqual(args, [scope.userId, scope.botId, 1]); trace.push('turn-start'); if (turnThrows) throw new Error('private provider error'); return { runId: 'synthetic-turn' } }
  assert.equal(workflow, deadlineWorkflow)
  assert.ok(trace.includes('claim-committed'))
  if (turnThrows) assert.ok(trace.includes('failed-committed'))
  assert.deepEqual(args, [turnThrows ? makeTicket(1, retryAt, null) : makeTicket()])
  trace.push('deadline-start')
  if (deadlineThrows) throw new Error('private workflow transport error')
  return { runId: 'synthetic-deadline' }
} } })
let wake: typeof import('./wake')
before(async () => { process.env.VERCEL = '1'; console.error = (...args) => { errors.push(args) }; wake = await import('./wake') })
beforeEach(() => { trace = []; errors = []; claimed = makeClaim(); resumed = { kind: 'obsolete' }; turnThrows = deadlineThrows = claimThrows = failureThrows = false; failureGate = undefined; defaultAvailable = ownModelReady = true; readinessCalls.length = 0; dueScopes = [] })
after(() => { if (originalVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = originalVercel; console.error = originalConsole })

test('normal immediate delivery arms one deadline only after its committed claim', async () => {
  await wake.wakeCoordinator(scope.userId)
  assert.deepEqual(trace, ['claim', 'claim-committed', 'triage', 'turn-start', 'deadline-start'])
})

test('a personal subscription wakes its own bot without a server default, and a withdrawn credential does not', async () => {
  defaultAvailable = false
  assert.equal(await wake.coordinatorEnabled(), false, 'no global readiness without a configured default')
  await wake.wakeCoordinator(scope.userId)
  assert.deepEqual(readinessCalls, [[scope.userId, scope.botId]])
  assert.ok(trace.includes('turn-start'))
  trace = []; ownModelReady = false
  await wake.wakeCoordinator(scope.userId)
  assert.deepEqual(trace, [], 'no claim, workflow or deadline starts without this bot\'s model')
  assert.equal(await wake.recoverWakeDeadline(makeTicket()), null)
  assert.deepEqual(readinessCalls.at(-1), [scope.userId, scope.botId], 'durable recovery checks the same bot')
})

test('the existing retry sweep considers subscription-backed bots without a global model or cloud connection', async () => {
  defaultAvailable = false; dueScopes = [scope]
  const outcome = await wake.retryCoordinatorWakes()
  assert.equal(outcome.due, 1); assert.equal(outcome.started, 1)
  assert.deepEqual(readinessCalls, [[scope.userId, scope.botId]])
  assert.ok(trace.includes('turn-start'))
  trace = []; ownModelReady = false
  const unavailable = await wake.retryCoordinatorWakes()
  assert.equal(unavailable.started, 0); assert.equal(unavailable.deferred, 1)
  assert.deepEqual(trace, [])
})

test('a failed delivery cannot arm its persisted backoff before the failure transaction commits', async () => {
  turnThrows = true
  let finish!: () => void
  failureGate = new Promise<void>(resolve => { finish = resolve })
  const running = wake.wakeCoordinator(scope.userId)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(trace.includes('failed-write'))
  assert.equal(trace.includes('deadline-start'), false)
  finish(); await running
  assert.deepEqual(trace.slice(-3), ['failed-write', 'failed-committed', 'deadline-start'])
  assert.equal(JSON.stringify(errors).includes('private'), false)
})

test('an uncertain deadline start does not repeat the start or change the accepted immediate delivery', async () => {
  deadlineThrows = true
  await wake.wakeCoordinator(scope.userId)
  assert.equal(trace.filter(value => value === 'turn-start').length, 1)
  assert.equal(trace.filter(value => value === 'deadline-start').length, 1)
  assert.equal(trace.includes('failed-write'), false)
  assert.equal(JSON.stringify(errors).includes('private'), false)
})

test('a failed claim or failure COMMIT cannot enqueue a deadline', async () => {
  claimThrows = true
  await wake.wakeCoordinator(scope.userId)
  assert.equal(trace.includes('turn-start'), false)
  assert.equal(trace.includes('deadline-start'), false)
  claimThrows = false; turnThrows = failureThrows = true; trace = []
  await wake.wakeCoordinator(scope.userId)
  assert.equal(trace.includes('failed-committed'), false)
  assert.equal(trace.includes('deadline-start'), false)
  assert.equal(JSON.stringify(errors).includes('private'), false)
})

test('an obsolete deadline exits and a real held lease only supplies its actual wait boundary', async () => {
  assert.equal(await wake.recoverWakeDeadline(makeTicket()), null)
  resumed = { kind: 'wait', at: '2026-11-04T12:10:00.000Z' }
  assert.deepEqual(await wake.recoverWakeDeadline(makeTicket()), { ticket: makeTicket(), at: resumed.at })
  assert.deepEqual(trace, ['resume', 'resume'])
})

test('a durable retry carries its new ticket without recursively starting another recovery workflow', async () => {
  resumed = { kind: 'claimed', claim: makeClaim(2) }
  assert.deepEqual(await wake.recoverWakeDeadline(makeTicket()), { ticket: makeTicket(2), at: leasedAt })
  assert.deepEqual(trace, ['resume', 'triage', 'turn-start'])
})
