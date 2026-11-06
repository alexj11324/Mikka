import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { encode } from '../../lib/desktop-rpc/wire.ts'
import { cancellationObserved, creationEvidence, managedEvidence, occurrenceEvidence,
  readTimerHook, reminderDefinition, runWorkflowMigrationProof } from './workflow-migration-production.mjs'

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), NOW = Date.parse('2026-11-06T12:00:00Z')
const ORIGIN = 'https://app.aspectlylabs.com', REPOSITORY = 'alexj11324/Mikka'
const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const DEPLOYMENT = 'dpl_SyntheticProofOnly', COORDINATOR = 'wrun_SYNTHETIC_COORDINATOR_01', TIMER = 'wrun_SYNTHETIC_TIMER_01'
const OWNER = 'synthetic-owner', EMAIL = 'owner+mikka-smoke@example.invalid', PASSWORD = 'SYNTHETIC_PASSWORD'
const COOKIE = 'SYNTHETIC_COOKIE', TOKEN = 'SYNTHETIC_MANAGER_TOKEN'
const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0')
const BOT = id(1), SCHEDULE = id(2), OCCURRENCE = id(3), OPERATION = id(4)
const MARKER = 'm1415-0123456789ab', DUE = new Date(NOW + 180_000).toISOString()
const PREFIX = 'f'.repeat(32)
const release = { id: 10, name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
  url: 'https://api.github.com/repos/' + REPOSITORY + '/actions/runs/10',
  event: 'push', head_branch: 'main', head_sha: SHA, repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY }, status: 'completed', conclusion: 'success' }
const event = { action: 'completed', repository: { full_name: REPOSITORY }, workflow_run: release }
const env = { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: SHA, GH_TOKEN: 'SYNTHETIC_GH_TOKEN', SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: PASSWORD, VERCEL_TEAM_TOKEN: TOKEN }
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers })
const stamp = ms => new Date(ms).toISOString()
const coordinator = () => ({ runId: COORDINATOR, deploymentId: DEPLOYMENT, status: 'completed', createdAt: stamp(NOW + 1000),
  workflowName: 'workflow//workflows/coordinator/workflow.ts//coordinatorTurn' })
const timer = () => ({ runId: TIMER, deploymentId: DEPLOYMENT, status: 'running', createdAt: stamp(NOW),
  workflowName: 'workflow//workflows/due-timer/workflow.ts//dueTimer' })
const events = () => [
  { runId: TIMER, eventType: 'wait_created', correlationId: 'wait_1', createdAt: stamp(NOW + 2000), eventData: { resumeAt: DUE } },
  { runId: TIMER, eventType: 'wait_completed', correlationId: 'wait_1', createdAt: stamp(NOW + 180_010) },
  { runId: TIMER, eventType: 'step_created', correlationId: 'step_1', createdAt: stamp(NOW + 180_020),
    eventData: { stepName: 'step//workflows/due-timer/steps.ts//runDue' } },
  { runId: TIMER, eventType: 'step_started', correlationId: 'step_1', createdAt: stamp(NOW + 180_030) },
  { runId: TIMER, eventType: 'step_completed', correlationId: 'step_1', createdAt: stamp(NOW + 180_100) },
]
const params = () => ({ coordinator: coordinator(), timer: timer(), events: events(), deploymentId: DEPLOYMENT,
  dueAt: DUE, occurrenceAt: NOW + 180_050, startedAt: NOW })
const creation = (marker = MARKER, at = DUE) => ({
  id: id(5), position: 2, from: 'coordinator', createdAt: stamp(NOW + 1000), text: 'Created.', streamId: COORDINATOR + ':0',
  // Literal public jsonb projection, including the real 200-character cut.
  activity: { tools: [{ name: 'schedule_create', state: 'done', call: 'call_1',
    input: ('{"definition": {"task": {"kind": "reminder", "text": "' + marker + '"}, "title": "' + marker
      + '", "timing": {"at": "' + at + '", "kind": "once"}, "misfire": "skip", "timezone": "UTC", "maxLatenessMinutes": 2}}').slice(0, 200),
    output: ('{"replayed": false, "schedule": {"id": "' + SCHEDULE + '", "bot_id": "' + BOT
      + '", "status": "active", "next_at": "' + at + '", "version": 1, "owner_id": "' + OWNER + '"}}').slice(0, 200) }] },
})
const outcome = marker => ({ id: OPERATION, position: 3, from: 'coordinator', createdAt: stamp(NOW + 180_050),
  text: '[Schedule ' + SCHEDULE + '; occurrence ' + OCCURRENCE + '; operation ' + OPERATION + '] ' + marker + ': succeeded\n' + marker })

test('creation proof uses actual bounded tool JSON, same bot, one call and non-replayed schedule identity', () => {
  const chat = { botId: BOT, items: [creation()] }
  assert.equal(creationEvidence(chat, 0, MARKER, DUE).scheduleId, SCHEDULE)
  assert.equal(creationEvidence({ botId: BOT, items: [{ ...creation(), text: 'Pretend success', activity: undefined }] }, 0, MARKER, DUE), null)
  for (const patch of [
    { input: creation().activity.tools[0].input.replace('"once"', '"daily"') },
    { output: creation().activity.tools[0].output.replace('"replayed": false', '"replayed": true') },
    { output: creation().activity.tools[0].output.replace(BOT, id(9)) },
  ]) {
    const item = creation(); Object.assign(item.activity.tools[0], patch)
    assert.throws(() => creationEvidence({ botId: BOT, items: [item] }, 0, MARKER, DUE), /creation_ambiguous/)
  }
  const duplicate = creation(); duplicate.activity.tools[0].call = 'second'
  assert.throws(() => creationEvidence({ botId: BOT, items: [creation(), duplicate] }, 0, MARKER, DUE), /creation_ambiguous/)
})

test('merged/model text cannot impersonate the host-committed schedule operation', () => {
  assert.ok(occurrenceEvidence({ items: [outcome(MARKER)] }, 0, MARKER, SCHEDULE))
  for (const patch of [{ id: id(8) }, { streamId: COORDINATOR + ':0' }, { from: 'person' }, { text: 'Created.\n\n' + outcome(MARKER).text }])
    assert.equal(occurrenceEvidence({ items: [{ ...outcome(MARKER), ...patch }] }, 0, MARKER, SCHEDULE), null)
  assert.equal(occurrenceEvidence({ items: [outcome(MARKER)] }, 0, MARKER, id(7)), null)
})

test('managed proof requires exact deployment, completed owner turn, matching due wait and subsequent completed runDue', () => {
  assert.ok(managedEvidence(params()))
  for (const value of [
    { coordinator: { ...coordinator(), status: 'running' } },
    { coordinator: { ...coordinator(), deploymentId: 'dpl_Old' } },
    { timer: { ...timer(), workflowName: 'workflow//other.ts//dueTimer' } },
    { events: events().filter(event => event.eventType !== 'wait_completed') },
    { events: events().map(event => event.eventType === 'wait_completed' ? { ...event, correlationId: 'different' } : event) },
    { events: events().map(event => event.eventType === 'step_completed' ? { ...event, createdAt: stamp(NOW + 170_000) } : event) },
    { events: events().filter(event => event.eventType !== 'step_started') },
    { occurrenceAt: NOW + 1 },
  ]) assert.equal(managedEvidence({ ...params(), ...value }), null)
  assert.equal(managedEvidence({ ...params(), timer: { ...timer(), status: 'running' } }).timerTerminalRequired, false)
  const optimistic = events().map(event => ['step_created', 'step_started'].includes(event.eventType)
    ? { ...event, createdAt: stamp(NOW + 180_070) } : event)
  const observed = managedEvidence({ ...params(), events: optimistic })
  assert.ok(observed, 'real SDK optimistic inline may persist step metadata after its business write')
  assert.equal(observed.concurrentReconciliationExcluded, false)
})

test('descending SDK pages retain an eligible completed correlation behind a newer incomplete runDue', () => {
  const descending = [...events(), { runId: TIMER, eventType: 'step_created', correlationId: 'later',
    createdAt: stamp(NOW + 180_200), eventData: { stepName: 'step//workflows/due-timer/steps.ts//runDue' } }].reverse()
  const observed = managedEvidence({ ...params(), events: descending })
  assert.ok(observed)
  assert.equal(observed.runDueCreatedAt, stamp(NOW + 180_020))
  assert.equal(observed.runDueCompletedAt, stamp(NOW + 180_100))
  assert.equal(managedEvidence({ ...params(), occurrenceAt: Number.NaN }), null)
})

test('normal cancellation accepts only the exact confirmed schedule and a successful versioned tool result', () => {
  const item = { position: 5, from: 'coordinator', activity: { tools: [{ name: 'schedule_cancel', state: 'done',
    input: JSON.stringify({ scheduleId: SCHEDULE, version: 2 }) }] } }
  assert.equal(cancellationObserved({ items: [item] }, 4, SCHEDULE), true)
  assert.equal(cancellationObserved({ items: [item] }, 4, id(8)), false)
  item.activity.tools[0].state = 'error'
  assert.equal(cancellationObserved({ items: [item] }, 4, SCHEDULE), false)
})


test('the real locked SDK absent-hook error is pending, while auth/transport errors remain failures', async () => {
  const sdkRequire = createRequire(import.meta.resolve('workflow'))
  const { HookNotFoundError } = await import(pathToFileURL(sdkRequire.resolve('@workflow/errors')).href)
  const absent = new HookNotFoundError('synthetic-token-not-evidence')
  assert.equal(absent.name, 'HookNotFoundError')
  assert.equal(absent.status, undefined)
  assert.equal(await readTimerHook(async () => { throw absent }), null)
  for (const error of [Object.assign(new Error('denied'), { status: 403 }), new Error('network unavailable')])
    await assert.rejects(readTimerHook(async () => { throw error }), value => value === error)
  const hook = { runId: TIMER }
  assert.equal(await readTimerHook(async () => hook), hook)
})

function fullFixture(options = {}) {
  let clock = NOW, definition, submitted = false, cancelled = false, timerReads = 0
  const requests = [], managerCalls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), headers = new Headers(init.headers), method = init.method ?? 'GET'
    requests.push({ origin: url.origin, path: url.pathname, method, body: init.body })
    assert.equal(init.redirect, 'error')
    if (url.origin === 'https://api.github.com') {
      assert.equal(headers.get('authorization'), 'Bearer SYNTHETIC_GH_TOKEN')
      if (url.pathname.endsWith('/issues/1415')) return json({ number: 1415, state: options.closed ? 'closed' : 'open',
        url: 'https://api.github.com/repos/' + REPOSITORY + '/issues/1415', repository_url: 'https://api.github.com/repos/' + REPOSITORY })
      if (url.pathname.endsWith('/git/ref/heads/main')) return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: options.wrongMain ? OTHER : SHA } })
      return json(release)
    }
    if (url.origin === 'https://api.vercel.com') {
      assert.equal(headers.get('authorization'), 'Bearer ' + TOKEN)
      assert.equal(url.searchParams.get('teamId'), TEAM); assert.equal(method, 'GET')
      return url.pathname.startsWith('/v4/') ? json({ alias: 'app.aspectlylabs.com', projectId: PROJECT, deploymentId: DEPLOYMENT, updatedAt: NOW })
        : json({ projectId: PROJECT, gitSource: { sha: SHA }, readyState: 'READY', target: 'production' })
    }
    assert.equal(url.origin, ORIGIN); assert.equal(headers.get('authorization'), null)
    if (url.pathname === '/mikka/api/version') return json({ build: SHA })
    assert.equal(headers.get('origin'), ORIGIN)
    if (url.pathname.endsWith('/sign-in/email')) {
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, password: PASSWORD })
      return json({}, 200, { 'set-cookie': 'better-auth.session_token=' + COOKIE + '; Path=/; Secure; HttpOnly' })
    }
    assert.equal(headers.get('cookie'), 'better-auth.session_token=' + COOKIE)
    if (url.pathname.endsWith('/sign-out')) return json({})
    if (url.pathname.endsWith('/get-session')) return json({ user: { id: OWNER, email: EMAIL } })
    if (url.pathname === '/mikka/api/workspace') return json({ currentUserId: OWNER, role: 'admin',
      workspace: { id: id(10), kind: options.shared ? 'shared' : 'personal' } })
    if (url.pathname === '/mikka/api/coordinator/messages' && method === 'POST') {
      const body = JSON.parse(init.body); assert.match(body.submissionId, /^[0-9a-f-]{36}$/)
      if (submitted) {
        assert.ok(body.text.includes(SCHEDULE)); assert.ok(body.text.includes('Cancel only'))
        cancelled = true
      } else {
        definition = JSON.parse(body.text.match(/exact definition: (\{.+\})\. It must/)[1])
        assert.deepEqual(definition, reminderDefinition(definition.title, definition.timing.at))
        submitted = true
      }
      return json({ queued: true, enabled: true }, 202)
    }
    if (url.pathname === '/mikka/api/rpc') {
      assert.equal(headers.get('x-mikka-rpc'), '1')
      const body = JSON.parse(init.body)
      assert.equal(body.action, 'coordinator.coordinatorHistory'); assert.equal(body.args[0], BOT); assert.equal(body.args[2], 1)
      return json({ ok: true, result: encode({ items: [outcome(definition.title)], cursor: 3 }) })
    }
    assert.equal(url.pathname, '/mikka/api/coordinator/messages')
    const after = Number(url.searchParams.get('after') ?? 0), baseCursor = Number(url.searchParams.get('cursor') ?? 0)
    const due = submitted && clock >= Date.parse(definition.timing.at) + 5000 && !options.noOccurrence
    const cursor = cancelled ? 4 : due ? 3 : submitted ? 2 : 0
    let items = []
    if (submitted) {
      const row = creation(definition.title, definition.timing.at)
      if (due) row.text += '\n\n' + outcome(definition.title).text // the real UI merge destroys the outcome row ID here
      items = [row]
    }
    if (cancelled) items.push({ id: id(11), position: 4, from: 'coordinator', text: 'Cancelled.', activity: { tools: [{
      name: 'schedule_cancel', state: 'done', call: 'cancel_call', input: JSON.stringify({ scheduleId: SCHEDULE, version: 1 }),
    }] } })
    return json({ enabled: true, botId: BOT, working: false, error: null, items, cursor, version: String(cursor + 1).repeat(32),
      sources: {}, artifacts: {}, continuation: { after: submitted ? 1 : 0, cursor, prefix: PREFIX },
      ...(url.search ? { after, baseCursor } : {}) })
  }
  const readerFactory = async (token, deploymentId) => {
    assert.equal(token, TOKEN); assert.equal(deploymentId, DEPLOYMENT)
    return {
      async probe() { managerCalls.push('probe'); if (options.managerDenied) throw new Error('PRIVATE_MANAGER_ERROR') },
      async timer() { managerCalls.push('timer'); return { runId: options.staleTimerFirst && timerReads++ === 0 ? 'wrun_SYNTHETIC_OLD_TIMER_01' : TIMER } },
      async getRun(id) { managerCalls.push('run'); return id === COORDINATOR ? coordinator() : id === 'wrun_SYNTHETIC_OLD_TIMER_01'
        ? { ...timer(), runId: id, deploymentId: 'dpl_OldDeployment' } : timer() },
      async events() { managerCalls.push('events'); return options.noWait ? events().filter(event => event.eventType !== 'wait_completed') : events() },
    }
  }
  return { requests, managerCalls, run: () => runWorkflowMigrationProof({ env, event, fetchImpl, now: () => clock,
    wait: async ms => { clock += ms }, readerFactory }) }
}

test('complete driver separates manager credentials, performs one normal post, reads real row identity and closes its session', async () => {
  const f = fullFixture(), report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(report.submissionCount, 1); assert.equal(report.cleanupSubmissionCount, 0)
  assert.equal(report.normalSessionObserved, true); assert.equal(report.sessionClosed, true)
  assert.equal(report.personalWorkspaceConfirmed, true); assert.equal(report.futureScheduleConfirmedAbsent, true)
  assert.ok(f.requests.some(row => row.path === '/mikka/api/rpc'), 'merged chat alone was insufficient')
  assert.ok(f.managerCalls.includes('events'))
  const publicText = JSON.stringify(report)
  for (const privateValue of [EMAIL, PASSWORD, COOKIE, TOKEN, OWNER, BOT, SCHEDULE, COORDINATOR, TIMER])
    assert.equal(publicText.includes(privateValue), false)
})

test('normal old-deployment hook handoff is observed without mutating or pinning the old timer', async () => {
  const f = fullFixture({ staleTimerFirst: true }), report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(report.sdkMutations, 0)
  assert.ok(f.managerCalls.filter(name => name === 'timer').length >= 2)
})

test('202, chat claim or cron-like outcome without a managed wait is never a pass', async () => {
  const f = fullFixture({ noWait: true }), report = await f.run()
  assert.equal(report.status, 'fail'); assert.equal(report.code, 'managed_evidence_missing')
  assert.equal(report.futureScheduleConfirmedAbsent, true)
  assert.equal(report.cleanupSubmissionCount, 0, 'already completed once-only reminder needs no cancellation')
  assert.equal(report.sessionClosed, true)
})

test('failed due result cancels only the exact tool-proven schedule through the normal owner path', async () => {
  const f = fullFixture({ noOccurrence: true }), report = await f.run()
  assert.equal(report.status, 'fail'); assert.equal(report.cleanupSubmissionCount, 1)
  assert.equal(report.futureScheduleEvidence, 'normal-owner-schedule-cancel')
  assert.equal(report.futureScheduleConfirmedAbsent, true); assert.equal(report.sessionClosed, true)
  assert.equal(f.requests.filter(row => row.path === '/mikka/api/coordinator/messages' && row.method === 'POST').length, 2)
})

test('closed issue, stale main, denied manager or shared workspace never submits a task', async () => {
  for (const options of [{ closed: true }, { wrongMain: true }, { managerDenied: true }, { shared: true }]) {
    const f = fullFixture(options), report = await f.run()
    assert.notEqual(report.status, 'pass')
    assert.equal(f.requests.some(row => row.path === '/mikka/api/coordinator/messages' && row.method === 'POST'), false)
  }
})

test('workflow keeps standalone read acceptance and serializes the bounded migration proof', async () => {
  const text = await readFile(new URL('../../.github/workflows/read-cache-production.yml', import.meta.url), 'utf8')
  const migration = text.slice(text.indexOf('  workflow-migration:'))
  const acceptance = text.slice(text.indexOf('  acceptance:'), text.indexOf('  workflow-migration:'))
  assert.match(acceptance, /run: node --import tsx scripts\/acceptance\/read-cache-production\.mjs\n/)
  assert.match(migration, /needs: \[guards, acceptance\]/)
  assert.match(migration, /read-cache-production\.mjs --attest --migration-1415/)
  assert.doesNotMatch(migration, /read-cache-production\.mjs --migration-1415/)
  assert.doesNotMatch(migration, /production-web-parity-evidence|sandboxes-cloud\.docker\.com/)
  assert.match(migration, /if: steps\.attest\.outputs\.readable == 'true'\n        run: pnpm exec playwright install --with-deps --only-shell chromium/)
  assert.match(migration, /if: steps\.attest\.outputs\.readable == 'true'\n        run: pnpm exec playwright test -c playwright\.smoke\.config\.ts/)
  assert.ok(migration.indexOf('secret-name: SMOKE_OWNER_PASSWORD') < migration.indexOf('run: pnpm exec playwright test'))
  assert.ok(migration.indexOf('run: pnpm exec playwright test') < migration.indexOf('secret-name: VERCEL_TEAM_TOKEN'))
  assert.match(text, /secret-name: VERCEL_TEAM_TOKEN/)
  assert.match(text, /workflow-migration-production\.test\.mjs/)
  const desktop = await readFile(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  assert.ok(!desktop.includes("'scripts/acceptance/"))
  assert.ok(!desktop.includes("'.github/workflows/read-cache-production.yml'"))
})
