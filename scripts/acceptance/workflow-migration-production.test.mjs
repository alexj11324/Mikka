import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { encode } from '../../lib/desktop-rpc/wire.ts'
import { cancellationObserved, creationEvidence, managedEvidence, occurrenceEvidence,
  readTimerHook, reminderDefinition, runWorkflowMigrationProof } from './workflow-migration-production.mjs'
import { DEPLOYED_WORKFLOW, attestDeployedTarget } from './deployed-target.mjs'

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), NOW = Date.parse('2026-11-06T12:00:00Z')
const ORIGIN = 'https://app.aspectlylabs.com', REPOSITORY = 'alexj11324/Mikka'
const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const DEPLOYMENT = 'dpl_SyntheticProofOnly', COORDINATOR = 'wrun_SYNTHETIC_COORDINATOR_01', TIMER = 'wrun_SYNTHETIC_TIMER_01'
const OWNER = 'synthetic-owner', EMAIL = 'owner+mikka-smoke@example.invalid', PASSWORD = 'SYNTHETIC_PASSWORD'
// Public policy identity from owner comment #1504/6691409495, not a login credential.
const POLICY_ADMIN_EMAIL = 'alex@acme.aspectlylabs.com'
const POLICY_ADMIN = 'synthetic-policy-admin'
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
  workflowName: 'workflow//./workflows/coordinator/workflow//coordinatorTurn' })
const timer = () => ({ runId: TIMER, deploymentId: DEPLOYMENT, status: 'running', createdAt: stamp(NOW),
  workflowName: 'workflow//./workflows/due-timer/workflow//dueTimer' })
const events = () => [
  { runId: TIMER, eventType: 'wait_created', correlationId: 'wait_1', createdAt: stamp(NOW + 2000), eventData: { resumeAt: DUE } },
  { runId: TIMER, eventType: 'wait_completed', correlationId: 'wait_1', createdAt: stamp(NOW + 180_010) },
  { runId: TIMER, eventType: 'step_created', correlationId: 'step_1', createdAt: stamp(NOW + 180_020),
    eventData: { stepName: 'step//./workflows/due-timer/steps//runDue' } },
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
    createdAt: stamp(NOW + 180_200), eventData: { stepName: 'step//./workflows/due-timer/steps//runDue' } }].reverse()
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
  let clock = NOW, definition, submitted = false, cancelled = false, timerReads = 0, deploymentReads = 0, teamSelected = false
  const requests = [], managerCalls = []
  const repository = { full_name: REPOSITORY, owner: { login: 'alexj11324' } }
  const selectedEnv = options.deployed ? { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: OTHER,
    GITHUB_REPOSITORY_OWNER: 'alexj11324', GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: REPOSITORY + '/' + DEPLOYED_WORKFLOW + '@refs/heads/main',
    MIKKA_ACCEPTANCE_TARGET_MODE: 'deployed-target', APPLICATION_SHA: SHA,
    WEB_DEPLOY_RUN_ID: '10', VERCEL_DEPLOYMENT_ID: DEPLOYMENT } : env
  const selectedEvent = options.deployed ? { repository,
    inputs: { application_sha: SHA, web_run_id: '10', deployment_id: DEPLOYMENT } } : event
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), headers = new Headers(init.headers), method = init.method ?? 'GET'
    requests.push({ origin: url.origin, path: url.pathname, search: url.search, method, body: init.body })
    assert.equal(init.redirect, 'error')
    if (url.origin === 'https://api.github.com') {
      assert.equal(headers.get('authorization'), 'Bearer SYNTHETIC_GH_TOKEN')
      if (options.deployed) {
        assert.notEqual(url.pathname, '/repos/' + REPOSITORY + '/git/ref/heads/main')
        if (url.pathname.endsWith('/actions/runs/20')) return json({ id: 20, run_attempt: 1,
          repository, head_repository: repository, url: 'https://api.github.com/repos/' + REPOSITORY + '/actions/runs/20',
          path: DEPLOYED_WORKFLOW, event: 'workflow_dispatch', head_branch: 'main', head_sha: OTHER,
          status: 'in_progress', conclusion: null })
        if (url.pathname.endsWith('/actions/runs/10')) return json({ ...release, repository, head_repository: repository, run_attempt: 1 })
        if (url.pathname.endsWith('/actions/runs/10/attempts/1/jobs')) return json({ total_count: 1, jobs: [{
          id: 30, run_id: 10, name: 'deploy', head_sha: SHA, status: 'completed', conclusion: 'success',
          steps: ['Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
            'Verify the public production version before releasing the deployment queue'].map(name => ({ name, status: 'completed', conclusion: 'success' })),
        }] })
      }
      if (url.pathname.endsWith('/issues/1415')) return json({ number: 1415, state: options.closed ? 'closed' : 'open',
        url: 'https://api.github.com/repos/' + REPOSITORY + '/issues/1415', repository_url: 'https://api.github.com/repos/' + REPOSITORY })
      if (url.pathname.endsWith('/git/ref/heads/main')) return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: options.wrongMain ? OTHER : SHA } })
      return json(release)
    }
    if (url.origin === 'https://api.vercel.com') {
      assert.equal(headers.get('authorization'), 'Bearer ' + TOKEN)
      assert.equal(url.searchParams.get('teamId'), TEAM); assert.equal(method, 'GET')
      return url.pathname.startsWith('/v4/') ? json({ alias: 'app.aspectlylabs.com', projectId: PROJECT,
        deploymentId: options.driftAfterSubmit && submitted ? 'dpl_ChangedSameSha' : DEPLOYMENT, updatedAt: NOW })
        : json({ id: DEPLOYMENT,
          ...(options.nestedProject ? { project: { id: PROJECT } } : { projectId: PROJECT }),
          ...(options.conflictingManagedProject && ++deploymentReads === 3
            ? { projectId: PROJECT, project: { id: 'prj_Foreign' } } : {}),
          gitSource: { sha: SHA }, readyState: 'READY', target: 'production' })
    }
    assert.equal(url.origin, ORIGIN); assert.equal(headers.get('authorization'), null)
    if (url.pathname === '/mikka/api/version') return json({ build: SHA })
    assert.equal(headers.get('origin'), ORIGIN)
    if (url.pathname.endsWith('/sign-in/email')) {
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, password: PASSWORD })
      return json({}, 200, { 'set-cookie': 'better-auth.session_token=' + COOKIE + '; Path=/; Secure; HttpOnly' })
    }
    assert.equal(headers.get('cookie'), 'better-auth.session_token=' + COOKIE + (teamSelected ? '; mikka-workspace=' + id(12) : ''))
    if (url.pathname.endsWith('/sign-out')) return json({}, options.logoutStatus ?? 200)
    if (url.pathname.endsWith('/get-session')) return json({ user: { id: OWNER, email: EMAIL } })
    if (url.pathname === '/mikka/api/workspace') {
      const candidate = url.searchParams.get('workspace')
      const choices = [{ id: id(10), kind: 'personal' }, ...(options.noTeams ? [] : [
        ...(options.oneTeam ? [] : [{ id: id(13), kind: 'team' }]), { id: id(12), kind: 'team' },
      ])]
      if (candidate) {
        assert.equal(url.search, '?workspace=' + candidate)
        assert.ok(choices.some(choice => choice.kind === 'team' && choice.id === candidate))
        if (options.candidateError && candidate === id(13)) return json({ error: 'PRIVATE_CANDIDATE_ERROR' }, 500)
      }
      const workspaceId = candidate ?? (teamSelected ? id(12) : id(10))
      return json({ currentUserId: OWNER, role: workspaceId === id(10) ? 'admin' : 'member',
        workspace: { id: options.candidateWrongScope && candidate ? id(19) : workspaceId,
          kind: workspaceId === id(10) ? 'personal' : 'team' }, choices,
        members: workspaceId === id(10) ? [] : [{ userId: POLICY_ADMIN,
          email: !options.noAdmin && (workspaceId === id(12) || options.multipleAdminMatches)
            ? POLICY_ADMIN_EMAIL : 'other-admin@example.invalid', role: 'admin', status: 'active' }] })
    }
    if (url.pathname === '/mikka/api/coordinator/messages') assert.equal(teamSelected, true, 'business must use the normal selected team cookie')
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
      if (body.action === 'workspace.switchWorkspace') {
        assert.deepEqual(body.args, [id(12)])
        teamSelected = true
        return json({ version: 1, ok: true, result: encode({ ok: true, data: { workspaceId: id(12) } }) }, 200,
          { 'set-cookie': 'mikka-workspace=' + id(12) + '; Path=/; Secure; HttpOnly; SameSite=Lax' })
      }
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
  return { requests, managerCalls, run: async () => {
    const proof = options.deployed ? await attestDeployedTarget({ env: selectedEnv, event: selectedEvent, fetchImpl, now: () => clock }) : undefined
    return runWorkflowMigrationProof({ env: selectedEnv, event: selectedEvent, fetchImpl, now: () => clock,
      wait: async ms => { clock += ms }, readerFactory,
      attestation: proof && { ...proof, ...options.attestationPatch } })
  } }
}

test('complete driver separates manager credentials, performs one normal post, reads real row identity and closes its session', async () => {
  const f = fullFixture(), report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(report.submissionCount, 1); assert.equal(report.cleanupSubmissionCount, 0)
  assert.equal(report.normalSessionObserved, true); assert.equal(report.sessionClosed, true)
  assert.equal(report.teamWorkspaceConfirmed, true); assert.equal(report.futureScheduleConfirmedAbsent, true)
  assert.ok(f.requests.some(row => row.path === '/mikka/api/rpc'), 'merged chat alone was insufficient')
  assert.ok(f.managerCalls.includes('events'))
  const publicText = JSON.stringify(report)
  for (const privateValue of [EMAIL, PASSWORD, COOKIE, TOKEN, OWNER, POLICY_ADMIN, POLICY_ADMIN_EMAIL, BOT, SCHEDULE, COORDINATOR, TIMER])
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

test('closed issue, stale main, denied manager or missing team never submits a task', async () => {
  for (const options of [{ closed: true }, { wrongMain: true }, { managerDenied: true }, { noTeams: true }]) {
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


test('explicit deployed target reuses the same owner and managed reminder proof with a different real driver', async () => {
  const f = fullFixture({ deployed: true }), report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(report.targetMode, 'deployed-target')
  assert.equal(report.applicationSha, SHA); assert.equal(report.driverRevision, OTHER)
  assert.equal(report.driverRunId, 20); assert.equal(report.driverRunAttempt, 1)
  assert.equal(report.webDeployJobId, 30); assert.equal(report.deploymentId, DEPLOYMENT)
  assert.equal(report.targetBefore.status, 'ready'); assert.equal(report.targetAfter.status, 'ready')
  assert.equal(report.managed.coordinatorCompleted, true); assert.equal(report.managed.dueTimerObserved, true)
  assert.equal(report.submissionCount, 1); assert.equal(report.cleanupSubmissionCount, 0)
  assert.equal(report.futureScheduleConfirmedAbsent, true); assert.equal(report.sessionClosed, true)
  for (const secret of [EMAIL, PASSWORD, COOKIE, TOKEN, OWNER, BOT, SCHEDULE])
    assert.equal(JSON.stringify(report).includes(secret), false)
})

test('deployed proof cannot be replaced by a legacy or different-driver file before owner access', async () => {
  for (const attestationPatch of [{ purpose: 'production-readiness' }, { driverRevision: SHA }, { driverRunId: 99 }]) {
    const f = fullFixture({ deployed: true, attestationPatch }), report = await f.run()
    assert.equal(report.status, 'blocked'); assert.equal(report.code, 'target_attestation')
    assert.equal(report.submissionCount, 0)
    assert.equal(f.requests.some(row => row.path.endsWith('/sign-in/email')), false)
  }
})

test('target drift still permits only exact known-schedule cleanup and closes the owned session', async () => {
  const f = fullFixture({ deployed: true, noOccurrence: true, driftAfterSubmit: true }), report = await f.run()
  assert.equal(report.status, 'inconclusive'); assert.equal(report.code, 'target_changed')
  assert.equal(report.businessFailure.code, 'reminder_not_observed')
  assert.equal(report.submissionCount, 1); assert.equal(report.cleanupSubmissionCount, 1)
  assert.equal(report.futureScheduleConfirmedAbsent, true); assert.equal(report.sessionClosed, true)
  assert.equal(report.futureScheduleEvidence, 'normal-owner-schedule-cancel')
  assert.equal(f.requests.filter(row => row.path === '/mikka/api/coordinator/messages' && row.method === 'POST').length, 2)
  const logout = f.requests.findLastIndex(row => row.path.endsWith('/sign-out'))
  const lastProof = f.requests.findLastIndex(row => row.path.endsWith('/actions/runs/20'))
  assert.ok(logout >= 0 && lastProof > logout, 'the final target check follows resource and session cleanup')
})

test('target drift cannot downgrade an actual cleanup failure to inconclusive', async () => {
  const f = fullFixture({ deployed: true, noOccurrence: true, driftAfterSubmit: true, logoutStatus: 500 })
  const report = await f.run()
  assert.equal(report.status, 'fail'); assert.equal(report.code, 'session_close_failed')
  assert.equal(report.sessionClosed, false); assert.equal(report.futureScheduleConfirmedAbsent, true)
  assert.equal(report.targetAfterFailure.code, 'target_changed')
})


test('new managed mode accepts the actual nested provider project identity without changing the default path', async () => {
  const report = await fullFixture({ deployed: true, nestedProject: true }).run()
  assert.equal(report.status, 'pass')
  assert.equal(report.managed.coordinatorCompleted, true)
  assert.equal(report.sessionClosed, true); assert.equal(report.futureScheduleConfirmedAbsent, true)
  const legacy = await fullFixture({ nestedProject: true }).run()
  assert.equal(legacy.status, 'fail'); assert.equal(legacy.code, 'deployment_mismatch')
  assert.equal(legacy.submissionCount, 0)
})

test('new managed repeated deployment read rejects conflicting project scopes before owner access', async () => {
  const f = fullFixture({ deployed: true, conflictingManagedProject: true }), report = await f.run()
  assert.notEqual(report.status, 'pass')
  assert.equal(report.submissionCount, 0)
  assert.equal(f.requests.some(row => row.path.endsWith('/sign-in/email')), false)
})

const HISTORY_SOURCE_REPORT = {
  "version": 1,
  "purpose": "workflow-migration-production",
  "issue": 1415,
  "applicationSha": "2960d783f0196fed5375593d910a43430a101747",
  "driverRevision": "c0c98baa3020a085652ee5f773310b6dfa412c5d",
  "webDeployRunId": 42276537062,
  "status": "fail",
  "normalSessionObserved": true,
  "sessionClosed": true,
  "submissionCount": 1,
  "cleanupSubmissionCount": 0,
  "sdkMutations": 0,
  "cronRequests": 0,
  "databaseWritesByDriver": 0,
  "providerLoginTested": false,
  "startedAt": "2026-11-06T20:06:04.595Z",
  "futureScheduleConfirmedAbsent": true,
  "targetMode": "deployed-target",
  "driverRunId": 42285115630,
  "driverRunAttempt": 1,
  "deploymentId": "dpl_9dfpxYacqybW7U2PcpviMu83ruSg",
  "targetBefore": {
    "purpose": "production-deployed-target",
    "repository": "alexj11324/Mikka",
    "targetMode": "deployed-target",
    "trigger": "workflow_dispatch",
    "mode": "readonly",
    "applicationSha": "2960d783f0196fed5375593d910a43430a101747",
    "driverRevision": "c0c98baa3020a085652ee5f773310b6dfa412c5d",
    "driverRunId": 42285115630,
    "driverRunAttempt": 1,
    "webDeployRunId": 42276537062,
    "deploymentId": "dpl_9dfpxYacqybW7U2PcpviMu83ruSg",
    "webAttempt": 1,
    "webDeployJobId": 128094181225,
    "projectId": "prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH",
    "teamId": "team_C7lwxVVvnUicFli6112mvxpv",
    "issueNumber": 1415,
    "issueState": "open",
    "status": "ready",
    "metadataReadAuthorized": true,
    "readable": true,
    "executionReady": false,
    "checkedAt": "2026-11-06T20:06:06.529Z"
  },
  "webAttempt": 1,
  "webDeployJobId": 128094181225,
  "personalWorkspaceConfirmed": true,
  "code": "http_failed",
  "futureScheduleEvidence": "observed-once-definition-and-committed-operation",
  "targetAfter": {
    "purpose": "production-deployed-target",
    "repository": "alexj11324/Mikka",
    "targetMode": "deployed-target",
    "trigger": "workflow_dispatch",
    "mode": "readonly",
    "applicationSha": "2960d783f0196fed5375593d910a43430a101747",
    "driverRevision": "c0c98baa3020a085652ee5f773310b6dfa412c5d",
    "driverRunId": 42285115630,
    "driverRunAttempt": 1,
    "webDeployRunId": 42276537062,
    "deploymentId": "dpl_9dfpxYacqybW7U2PcpviMu83ruSg",
    "webAttempt": 1,
    "webDeployJobId": 128094181225,
    "projectId": "prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH",
    "teamId": "team_C7lwxVVvnUicFli6112mvxpv",
    "issueNumber": 1415,
    "issueState": "open",
    "status": "ready",
    "metadataReadAuthorized": true,
    "readable": true,
    "executionReady": false,
    "checkedAt": "2026-11-06T20:13:08.828Z"
  },
  "finishedAt": "2026-11-06T20:13:08.828Z"
}
const HISTORY_WORKFLOW = '.github/workflows/issue1415-managed-inspection.yml'
const HISTORY_RUN_ID = 42285115630, HISTORY_JOB_ID = 128123815664
const HISTORY_SOURCE_SHA = 'c0c98baa3020a085652ee5f773310b6dfa412c5d'
const HISTORY_DEPLOYMENT = 'dpl_9dfpxYacqybW7U2PcpviMu83ruSg'
const HISTORY_APP = '2960d783f0196fed5375593d910a43430a101747'
const HISTORY_API = 'https://api.github.com/repos/alexj11324/Mikka'

function historyFixture() {
  const repo = { full_name: REPOSITORY, owner: { login: 'alexj11324', id: 183887963 } }
  const driver = { id: 991, run_attempt: 1, repository: repo, head_repository: repo,
    url: HISTORY_API + '/actions/runs/991', path: HISTORY_WORKFLOW,
    event: 'workflow_dispatch', head_branch: 'main', head_sha: OTHER,
    status: 'in_progress', conclusion: null }
  const original = { id: HISTORY_RUN_ID, run_attempt: 1, repository: repo, head_repository: repo,
    url: HISTORY_API + '/actions/runs/' + HISTORY_RUN_ID,
    path: '.github/workflows/issue1415-deployed-production.yml', workflow_id: 409730660,
    event: 'workflow_dispatch', head_branch: 'main', head_sha: HISTORY_SOURCE_SHA,
    status: 'completed', conclusion: 'failure' }
  const job = { id: HISTORY_JOB_ID, run_id: HISTORY_RUN_ID, run_attempt: 1, head_sha: HISTORY_SOURCE_SHA,
    name: 'acceptance', status: 'completed', conclusion: 'failure', steps: [
      { name: 'Verify the normal owner browser and close only its own session', status: 'completed', conclusion: 'success' },
      { name: 'Prove one normal Coordinator turn and its managed due reminder', status: 'completed', conclusion: 'failure' },
    ] }
  const fixtureEnv = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_OWNER: 'alexj11324',
    GITHUB_REPOSITORY_OWNER_ID: '183887963', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: REPOSITORY + '/' + HISTORY_WORKFLOW + '@refs/heads/main', GITHUB_SHA: OTHER,
    GITHUB_RUN_ID: '991', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'SYNTHETIC_GH_TOKEN', SOURCE_RUN_ID: String(HISTORY_RUN_ID) }
  const fixtureEvent = { repository: repo, inputs: { source_run_id: String(HISTORY_RUN_ID) } }
  const rows = {
    [HISTORY_API + '/actions/runs/991']: driver,
    [HISTORY_API + '/issues/1415']: { number: 1415, state: 'open', url: HISTORY_API + '/issues/1415', repository_url: HISTORY_API },
    [HISTORY_API + '/actions/runs/' + HISTORY_RUN_ID]: original,
    [HISTORY_API + '/actions/runs/' + HISTORY_RUN_ID + '/attempts/1']: original,
    [HISTORY_API + '/actions/runs/' + HISTORY_RUN_ID + '/attempts/1/jobs?per_page=100']: { total_count: 1, jobs: [job] },
    [HISTORY_API + '/actions/jobs/' + HISTORY_JOB_ID + '/logs']:
      '2026-11-06T20:13:08.8310948Z ' + JSON.stringify(HISTORY_SOURCE_REPORT) + '\n',
  }
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init?.method })
    assert.equal(init?.method, 'GET')
    const value = rows[String(url)]
    assert.notEqual(value, undefined, 'only the named GitHub read endpoints are authorized')
    return typeof value === 'string' ? new Response(value) : json(value)
  }
  return { env: fixtureEnv, event: fixtureEvent, rows, requests, fetchImpl }
}

test('historical source CLI verifies the completed failed report without owner or platform credentials', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const dir = await mkdtemp(join(tmpdir(), 'mikka-managed-history-'))
  try {
    const f = historyFixture()
    const fixturePath = join(dir, 'github-fixture.json'), eventPath = join(dir, 'event.json'), preload = join(dir, 'fetch.mjs')
    await writeFile(fixturePath, JSON.stringify(f.rows))
    await writeFile(eventPath, JSON.stringify(f.event))
    await writeFile(preload, `import { readFileSync } from 'node:fs'; const rows=JSON.parse(readFileSync(process.env.HISTORY_FIXTURE,'utf8'));
globalThis.fetch=async(url,init)=>{if(init?.method!=='GET'||!Object.hasOwn(rows,String(url)))throw new Error('SYNTHETIC_UNEXPECTED_IO');
const value=rows[String(url)];return typeof value==='string'?new Response(value):Response.json(value)};`)
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('./workflow-migration-production.mjs', import.meta.url)), '--inspect-source'],
    { cwd: dir, env: { PATH: process.env.PATH, ...f.env, GITHUB_EVENT_PATH: eventPath,
      HISTORY_FIXTURE: fixturePath, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) },
    encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.status, 0, 'an authorized read-only inspection must not enter the owner business gate: ' + result.stdout)
    const value = JSON.parse(await readFile(join(dir, 'production-managed-inspection-report/source.json'), 'utf8'))
    assert.equal(value.status, 'inspected')
    assert.equal(value.inspectionStage, 'source')
    assert.equal(value.sourceReportCanonicalSha256, 'e261780128a5ed77baf1de32267272f168c134b9ab8d240bb55c231b158d0a8e')
    assert.equal(value.businessExecutionVerified, false)
    assert.equal(value.ownerRequests, 0); assert.equal(value.modelCalls, 0); assert.equal(value.sdkMutations, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

async function historyMetadataFixture() {
  const f = historyFixture()
  f.env.VERCEL_TEAM_TOKEN = TOKEN
  const calls = [], begin = Date.parse(HISTORY_SOURCE_REPORT.startedAt), finish = Date.parse(HISTORY_SOURCE_REPORT.finishedAt)
  const oldDeployment = 'dpl_SyntheticPreviousDeployment'
  const runRows = [
    { runId: COORDINATOR, deploymentId: HISTORY_DEPLOYMENT, status: 'completed',
      workflowName: 'workflow//./workflows/coordinator/workflow//coordinatorTurn', createdAt: stamp(begin + 1000), completedAt: stamp(begin + 20_000) },
    { runId: TIMER, deploymentId: oldDeployment, status: 'completed',
      workflowName: 'workflow//./workflows/due-timer/workflow//dueTimer', createdAt: stamp(begin - 120_000), completedAt: stamp(finish - 1000) },
  ]
  const expectedEvents = [
    { runId: TIMER, eventType: 'run_completed', createdAt: stamp(finish - 1000) },
    { runId: TIMER, eventType: 'step_completed', correlationId: 'synthetic-step-correlation', createdAt: stamp(begin + 181_000) },
    { runId: TIMER, eventType: 'step_started', correlationId: 'synthetic-step-correlation', createdAt: stamp(begin + 180_100) },
    { runId: TIMER, eventType: 'step_created', correlationId: 'synthetic-step-correlation', createdAt: stamp(begin + 180_050),
      eventData: { stepName: 'step//./workflows/due-timer/steps//runDue' } },
    { runId: TIMER, eventType: 'wait_completed', correlationId: 'synthetic-wait-correlation', createdAt: stamp(begin + 180_000) },
    { runId: TIMER, eventType: 'wait_created', correlationId: 'synthetic-wait-correlation', createdAt: stamp(begin - 2000),
      eventData: { resumeAt: new Date(begin + 180_000) } },
  ]
  for (const row of [...runRows, ...expectedEvents]) {
    for (const key of ['input', 'output', 'payload', 'error'])
      Object.defineProperty(row, key, { get() { return assert.fail('private SDK data must not be read') } })
  }
  const storage = {
    runs: {
      async list(options) {
        calls.push({ operation: 'list', options }); assert.equal(options.resolveData, 'none')
        assert.ok(['workflow//./workflows/coordinator/workflow//coordinatorTurn',
          'workflow//./workflows/due-timer/workflow//dueTimer'].includes(options.workflowName))
        return { data: runRows.filter(row => row.workflowName === options.workflowName), hasMore: false, cursor: null }
      },
      async get(runId, options) {
        calls.push({ operation: 'get', options }); assert.equal(options.resolveData, 'none')
        return runRows.find(row => row.runId === runId)
      },
    },
    events: { async list(options) {
      calls.push({ operation: 'events', options }); assert.equal(options.resolveData, 'none')
      return { data: options.runId === TIMER ? expectedEvents : [], hasMore: false, cursor: null }
    } },
  }
  const factory = async config => {
    assert.deepEqual(config, { token: TOKEN, projectConfig: { projectId: PROJECT, teamId: TEAM, environment: 'production' } })
    return storage
  }
  const github = f.fetchImpl
  f.fetchImpl = async (url, init) => {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://api.vercel.com') return github(url, init)
    f.requests.push({ url: String(url), method: init?.method })
    assert.equal(init?.method, 'GET'); assert.equal(parsed.searchParams.get('teamId'), TEAM)
    const deploymentId = parsed.pathname.slice('/v13/deployments/'.length)
    assert.ok([HISTORY_DEPLOYMENT, oldDeployment].includes(deploymentId))
    return json({ id: deploymentId, project: { id: PROJECT }, ownerId: TEAM,
      target: 'production', readyState: 'READY', meta: { githubCommitSha: HISTORY_APP } })
  }
  return { ...f, calls, storage, factory, runRows, expectedEvents }
}

test('historical metadata inspection includes completed and previous-deployment timer candidates without claiming attribution', async () => {
  const { inspectManagedHistory } = await import('./workflow-migration-production.mjs')
  const f = await historyMetadataFixture()
  const report = await inspectManagedHistory({ env: f.env, event: f.event, fetchImpl: f.fetchImpl,
    metadata: true, createStorageImpl: f.factory })
  assert.equal(report.status, 'inspected')
  assert.equal(report.businessExecutionVerified, false)
  assert.equal(report.ownerRequests, 0); assert.equal(report.modelCalls, 0); assert.equal(report.sdkMutations, 0)
  assert.equal(report.candidates.length, 2)
  const previous = report.candidates.find(row => row.nameClass === 'dueTimer')
  assert.equal(previous.status, 'completed')
  assert.equal(previous.sourceMatches, true); assert.equal(previous.deploymentMatches, false)
  assert.equal(previous.sourceAttribution, 'candidate-only')
  assert.ok(previous.rejectReasons.includes('deployment_mismatch'))
  assert.ok(previous.events.some(row => row.eventType === 'wait_created' && row.inSourceWindow === false))
  assert.ok(previous.events.some(row => row.stepNameClass === 'runDue'))
  assert.ok(previous.events.some(row => row.eventType === 'run_completed'))
  assert.equal(report.listing.canonicalFilters, 2)
  assert.deepEqual(f.calls.filter(row => row.operation === 'list').map(row => row.options.workflowName), [
    'workflow//./workflows/coordinator/workflow//coordinatorTurn',
    'workflow//./workflows/due-timer/workflow//dueTimer',
  ])
  const output = JSON.stringify(report)
  for (const privateValue of [TOKEN, COORDINATOR, TIMER, 'synthetic-step-correlation', 'synthetic-wait-correlation'])
    assert.equal(output.includes(privateValue), false)
})

test('historical source identity and changed report are rejected before any platform read', async () => {
  const { inspectManagedHistory } = await import('./workflow-migration-production.mjs')
  const changes = [
    f => { f.env.GITHUB_REF = 'refs/heads/other' },
    f => { f.env.GITHUB_WORKFLOW_REF = REPOSITORY + '/.github/workflows/issue1415-deployed-production.yml@refs/heads/main' },
    f => { f.rows[HISTORY_API + '/actions/runs/991'].head_sha = SHA },
    f => { f.rows[HISTORY_API + '/issues/1415'].state = 'closed' },
    f => { f.rows[HISTORY_API + '/actions/runs/' + HISTORY_RUN_ID].run_attempt = 2 },
    f => { f.rows[HISTORY_API + '/actions/runs/' + HISTORY_RUN_ID + '/attempts/1/jobs?per_page=100'].jobs[0].id++ },
    f => { f.rows[HISTORY_API + '/actions/jobs/' + HISTORY_JOB_ID + '/logs'] =
      JSON.stringify({ ...HISTORY_SOURCE_REPORT, targetAfter: { ...HISTORY_SOURCE_REPORT.targetAfter, checkedAt: '2026-11-06T20:13:08.829Z' } }) },
  ]
  for (const change of changes) {
    const f = historyFixture(); change(f)
    const report = await inspectManagedHistory({ env: { ...f.env, VERCEL_TEAM_TOKEN: TOKEN }, event: f.event, fetchImpl: f.fetchImpl,
      metadata: true, createStorageImpl: () => assert.fail('source rejection must precede SDK creation') })
    assert.equal(report.status, 'blocked')
    assert.equal(report.businessExecutionVerified, false)
    assert.equal(f.requests.every(row => row.method === 'GET' && new URL(row.url).origin === 'https://api.github.com'), true)
  }
})

test('metadata phase re-reads the completed source rather than trusting the first source inspection', async () => {
  const { inspectManagedHistory } = await import('./workflow-migration-production.mjs')
  const f = historyFixture()
  assert.equal((await inspectManagedHistory({ env: f.env, event: f.event, fetchImpl: f.fetchImpl })).status, 'inspected')
  f.rows[HISTORY_API + '/actions/jobs/' + HISTORY_JOB_ID + '/logs'] +=
    JSON.stringify(HISTORY_SOURCE_REPORT) + '\n'
  const report = await inspectManagedHistory({ env: { ...f.env, VERCEL_TEAM_TOKEN: TOKEN }, event: f.event,
    fetchImpl: f.fetchImpl, metadata: true, createStorageImpl: () => assert.fail('duplicate proof cannot authorize the SDK') })
  assert.equal(report.status, 'blocked'); assert.equal(report.code, 'inspection_source'); assert.equal(report.detail, 'report')
})

test('GitHub signed log redirect receives no authorization and unrelated redirect origins are rejected', async () => {
  const { inspectManagedHistory } = await import('./workflow-migration-production.mjs')
  for (const allowed of [true, false]) {
    const f = historyFixture(), calls = []
    const signed = allowed ? 'https://productionresults123.blob.core.windows.net/logs/read?sig=synthetic'
      : 'https://unrelated.example.invalid/read'
    const original = f.fetchImpl
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/actions/jobs/' + HISTORY_JOB_ID + '/logs'))
        return new Response(null, { status: 302, headers: { location: signed } })
      if (String(url) === signed) {
        calls.push(init)
        assert.equal(init.headers.authorization, undefined); assert.equal(init.method, 'GET')
        return new Response(f.rows[HISTORY_API + '/actions/jobs/' + HISTORY_JOB_ID + '/logs'])
      }
      return original(url, init)
    }
    const report = await inspectManagedHistory({ env: f.env, event: f.event, fetchImpl })
    assert.equal(report.status, allowed ? 'inspected' : 'blocked')
    assert.equal(calls.length, allowed ? 1 : 0)
    assert.equal(JSON.stringify(report).includes('sig=synthetic'), false)
  }
})

test('bounded SDK history rejects repeated cursors and never falls back to mutation or unrestricted names', async () => {
  const { inspectManagedHistory } = await import('./workflow-migration-production.mjs')
  const f = await historyMetadataFixture(); let pages = 0
  f.storage.runs.list = async options => {
    pages++; assert.equal(options.resolveData, 'none'); assert.ok(options.workflowName.startsWith('workflow//'))
    return { data: [], hasMore: true, cursor: 'SYNTHETIC_SAME_CURSOR' }
  }
  const report = await inspectManagedHistory({ env: f.env, event: f.event, fetchImpl: f.fetchImpl,
    metadata: true, createStorageImpl: f.factory })
  assert.equal(report.status, 'blocked'); assert.equal(report.code, 'inspection_metadata'); assert.equal(report.detail, 'page')
  assert.equal(pages, 2); assert.equal(report.sdkMutations, 0)
})

test('historical metadata scopes and SDK failures remain closed and do not expose error or event payloads', async () => {
  const { inspectManagedHistory } = await import('./workflow-migration-production.mjs')
  for (const kind of ['scope', 'event', 'error']) {
    const f = await historyMetadataFixture()
    let fetchImpl = f.fetchImpl
    if (kind === 'scope') {
      const original = fetchImpl
      fetchImpl = async (url, init) => new URL(url).origin === 'https://api.vercel.com'
        ? json({ id: HISTORY_DEPLOYMENT, projectId: PROJECT, project: { id: 'prj_OTHER' },
          ownerId: TEAM, target: 'production', meta: { githubCommitSha: HISTORY_APP } }) : original(url, init)
    } else if (kind === 'event') {
      f.storage.events.list = async () => ({ data: [{ runId: 'wrun_UNRELATED_PRIVATE', eventType: 'wait_created',
        createdAt: HISTORY_SOURCE_REPORT.startedAt, eventData: { input: 'SYNTHETIC_PRIVATE_TEXT' } }], hasMore: false })
    } else f.storage.runs.list = async () => { throw new Error('SYNTHETIC_PRIVATE_TEXT') }
    const report = await inspectManagedHistory({ env: f.env, event: f.event, fetchImpl,
      metadata: true, createStorageImpl: f.factory })
    assert.equal(report.status, 'blocked')
    for (const value of ['SYNTHETIC_PRIVATE_TEXT', 'wrun_UNRELATED_PRIVATE', TOKEN])
      assert.equal(JSON.stringify(report).includes(value), false)
  }
})

test('historical workflow loads only the existing platform credential after its real source gate', async () => {
  const text = await readFile(new URL('../../.github/workflows/issue1415-managed-inspection.yml', import.meta.url), 'utf8')
  assert.match(text, /workflow_dispatch:/)
  assert.match(text, /source_run_id:/)
  assert.match(text, /github\.ref == 'refs\/heads\/main'/)
  assert.equal((text.match(/secret-name:/g) ?? []).length, 1)
  assert.match(text, /secret-name: VERCEL_TEAM_TOKEN/)
  assert.doesNotMatch(text, /SMOKE_OWNER|workflow-migration-production\.mjs\s*\n/)
  assert.ok(text.indexOf('--inspect-source') < text.indexOf('secret-name: VERCEL_TEAM_TOKEN'))
  assert.ok(text.indexOf('secret-name: VERCEL_TEAM_TOKEN') < text.indexOf('--inspect-managed'))
  assert.match(text, /production-managed-inspection-report\/source\.json/)
  assert.match(text, /production-managed-inspection-report\/report\.json/)
})

test('timer candidate listing stops at the explicit six-hour creation window and reports that limit', async () => {
  const { inspectManagedHistory } = await import('./workflow-migration-production.mjs')
  const f = await historyMetadataFixture()
  const ancient = { runId: 'wrun_SYNTHETIC_OLDER_TIMER', deploymentId: HISTORY_DEPLOYMENT, status: 'running',
    workflowName: 'workflow//./workflows/due-timer/workflow//dueTimer',
    createdAt: stamp(Date.parse(HISTORY_SOURCE_REPORT.startedAt) - 6 * 60 * 60_000 - 2000) }
  f.runRows.push(ancient)
  const list = f.storage.runs.list
  f.storage.runs.list = async options => {
    const value = await list(options)
    return options.workflowName === ancient.workflowName ? { ...value, hasMore: true, cursor: 'SYNTHETIC_OLDER_HISTORY' } : value
  }
  const report = await inspectManagedHistory({ env: f.env, event: f.event, fetchImpl: f.fetchImpl,
    metadata: true, createStorageImpl: f.factory })
  assert.equal(report.status, 'inspected'); assert.equal(report.candidates.length, 2)
  assert.equal(report.listing.olderTimersInspected, false)
  assert.equal(report.listing.timerCreatedNotBefore, '2026-11-06T14:06:03.595Z')
  assert.equal(f.calls.filter(row => row.operation === 'list').length, 2)
})

test('invalid or additional inspection CLI arguments cannot enter owner business code', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  for (const args of [['--inspect-unknown'], ['--inspect-managed', '--unexpected']]) {
    const dir = await mkdtemp(join(tmpdir(), 'mikka-managed-invalid-'))
    try {
      const preload = join(dir, 'deny.mjs')
      await writeFile(preload, "globalThis.fetch=()=>{throw new Error('SYNTHETIC_NO_IO_ALLOWED')}")
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href,
        fileURLToPath(new URL('./workflow-migration-production.mjs', import.meta.url)), ...args],
      { cwd: dir, env: { PATH: process.env.PATH,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) }, encoding: 'utf8', timeout: 20_000 })
      assert.equal(result.status, 1)
      const report = JSON.parse(result.stdout.trim())
      assert.equal(report.purpose, 'workflow-migration-history-inspection')
      assert.equal(report.status, 'blocked'); assert.equal(report.code, 'inspection_configuration')
      assert.equal(report.detail, 'inputs'); assert.equal(report.ownerRequests, 0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})


test('automatic and explicit proof select the unique policy admin team among multiple memberships', async () => {
  for (const deployed of [false, true]) {
    const f = fullFixture({ deployed }), report = await f.run()
    assert.equal(report.status, 'pass')
    assert.equal(report.teamWorkspaceConfirmed, true)
    assert.match(report.teamWorkspaceHash, /^[a-f0-9]{64}$/)
    assert.equal(report.teamAdminMembershipVerified, true)
    assert.equal(report.teamSelectionBasis, 'unique-active-admin-identity-match')
    assert.equal(report.teamOwnerAttribution, 'AGENTS.md-and-owner-comment-1504-6691409495')
    assert.equal(report.personalWorkspaceConfirmed, undefined)
    assert.equal(report.submissionCount, 1)
    assert.equal(report.sessionClosed, true)
    const switches = f.requests.filter(row => row.path === '/mikka/api/rpc'
      && JSON.parse(row.body).action === 'workspace.switchWorkspace')
    assert.equal(switches.length, 1)
    const candidates = f.requests.filter(row => row.path === '/mikka/api/workspace' && row.search)
    assert.deepEqual(candidates.map(row => row.search), [id(13), id(12)].map(value => '?workspace=' + value))
    assert.ok(candidates.every(row => row.method === 'GET' && row.body === undefined))
    const beforeSwitch = f.requests.indexOf(switches[0])
    assert.ok(candidates.every(row => f.requests.indexOf(row) < beforeSwitch))
    assert.equal(JSON.stringify(report).includes(id(12)), false)
    assert.equal(JSON.stringify(report).includes(POLICY_ADMIN_EMAIL), false)
  }
})


test('ambiguous team selection closes the normal session without any Coordinator submission', async () => {
  for (const deployed of [false, true]) {
    const f = fullFixture({ deployed, multipleAdminMatches: true }), report = await f.run()
    assert.equal(report.status, 'fail')
    assert.equal(report.code, 'team_workspace_failed'); assert.equal(report.detail, 'team_admin_ambiguous')
    assert.equal(report.submissionCount, 0); assert.equal(report.sessionClosed, true)
    assert.equal(f.requests.some(row => row.path === '/mikka/api/coordinator/messages'), false)
    if (deployed) assert.equal(report.targetAfter.status, 'ready')
  }
})


test('missing admin and unreadable or mismatched candidate keep cleanup and target fences without submitting', async () => {
  for (const deployed of [false, true]) {
    for (const [options, detail] of [
      [{ noAdmin: true, oneTeam: true }, 'team_admin_missing'],
      [{ candidateError: true }, 'candidate_read'],
      [{ candidateWrongScope: true }, 'candidate_identity'],
    ]) {
      const f = fullFixture({ deployed, ...options }), report = await f.run()
      assert.equal(report.status, 'fail')
      assert.equal(report.code, 'team_workspace_failed'); assert.equal(report.detail, detail)
      assert.equal(report.teamAdminMembershipVerified, false)
      assert.equal(report.submissionCount, 0); assert.equal(report.sessionClosed, true)
      assert.equal(f.requests.some(row => row.path === '/mikka/api/coordinator/messages'), false)
      assert.equal(f.requests.some(row => row.path === '/mikka/api/rpc'), false)
      if (deployed) assert.equal(report.targetAfter.status, 'ready')
    }
  }
})

test('historical managed evidence accepts locked compiler identifiers and rejects source-file aliases', async () => {
  const workflowRequire = createRequire(import.meta.resolve('workflow/nitro'))
  const nitroRequire = createRequire(workflowRequire.resolve('@workflow/nitro'))
  const builders = pathToFileURL(nitroRequire.resolve('@workflow/builders'))
  const { applySwcTransform } = await import(new URL('./apply-swc-transform.js', builders).href)
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  // Retain the old report codec after the Coordinator moved to native Eve.
  const historicalCoordinator = `export async function coordinatorTurn() {
    'use workflow'
    return null
  }`
  const ids = []
  for (const [file, mode, name] of [
    ['workflows/coordinator/workflow.ts', 'workflow', 'coordinatorTurn'],
    ['workflows/due-timer/workflow.ts', 'workflow', 'dueTimer'],
    ['workflows/due-timer/steps.ts', 'step', 'runDue'],
  ]) {
    const filename = fileURLToPath(new URL('../../' + file, import.meta.url))
    const source = file === 'workflows/coordinator/workflow.ts' ? historicalCoordinator : await readFile(filename, 'utf8')
    const transformed = await applySwcTransform(file, source, mode, filename, root, root)
    const entry = transformed.workflowManifest[mode === 'workflow' ? 'workflows' : 'steps'][file][name]
    ids.push(entry[mode === 'workflow' ? 'workflowId' : 'stepId'])
  }
  assert.deepEqual(ids, [
    'workflow//./workflows/coordinator/workflow//coordinatorTurn',
    'workflow//./workflows/due-timer/workflow//dueTimer',
    'step//./workflows/due-timer/steps//runDue',
  ])
  const p = params()
  p.coordinator.workflowName = ids[0]
  p.timer.workflowName = ids[1]
  p.events.find(event => event.eventType === 'step_created').eventData.stepName = ids[2]
  assert.ok(managedEvidence(p), 'actual generated IDs must satisfy the otherwise valid managed evidence')
  for (const rewrite of [
    value => value.replace('//coordinatorTurn', '.ts//coordinatorTurn').replace('//dueTimer', '.ts//dueTimer').replace('//runDue', '.ts//runDue'),
    value => value.replace('//./', '//'),
    value => value + 'Other',
  ]) {
    assert.equal(managedEvidence({ ...p, coordinator: { ...p.coordinator, workflowName: rewrite(ids[0]) } }), null)
    assert.equal(managedEvidence({ ...p, timer: { ...p.timer, workflowName: rewrite(ids[1]) } }), null)
    assert.equal(managedEvidence({ ...p, events: p.events.map(event => event.eventType === 'step_created'
      ? { ...event, eventData: { stepName: rewrite(ids[2]) } } : event) }), null)
  }
})
