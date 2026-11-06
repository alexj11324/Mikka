// Offline fixtures only: the default network is disabled for this whole file.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ALEX_OWNER_ID, alexSession } from './alex-session.mjs'
import { observeAccounts, TARGET } from './accounts-readonly.mjs'
import { QUERIES, readTraces, TRACE } from './coordinator-traces.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const SHA = '2cba2a841ab770692559f1e5e18a0a57cff99952'
const SMOKE_BOT = '3bc88a86-2a0a-44f3-8418-7a9253200103'
const ALEX_BOT = '11111111-1111-4111-8111-111111111111'
const OPTION = '22222222-2222-4222-8222-222222222222'
const PRIVATE = 'PRIVATE_CANARY_MUST_NOT_APPEAR'

function accountFixture(ownerId, { alexBot = false, otherMember = false, wrongBotOwner = false, active = false, unknownError = false } = {}) {
  const state = { chatReads: 0, menuReads: 0, switches: 0, signouts: 0, actions: [], reads: [] }
  const requests = []
  const isAlex = ownerId === ALEX_OWNER_ID
  let selected = false
  const provider = async (work, options) => {
    assert.equal(options.expectedSha, null)
    try {
      return await work({ identity: { userId: ownerId }, version: { build: SHA }, requests,
        async request(path, input = {}) {
          state.reads.push(path)
          let value
          if (path === '/api/workspace/switcher') value = { workspace: { id: selected ? TARGET.id : 'personal' },
            accounts: [{ id: ownerId, email: PRIVATE, choices: [{ id: TARGET.id, name: TARGET.name, kind: 'team' }] }] }
          else if (path === '/api/workspace?workspace=' + TARGET.id) value = {
            workspace: { id: TARGET.id, kind: 'team', name: TARGET.name }, currentUserId: ownerId, role: isAlex ? 'member' : 'admin',
            members: [{ userId: TARGET.smokeOwner, role: 'admin', status: 'active', name: PRIVATE, email: PRIVATE },
              { userId: ALEX_OWNER_ID, role: 'member', status: 'active', name: PRIVATE, email: PRIVATE },
              ...(otherMember ? [{ userId: PRIVATE, role: 'member', status: 'active', email: PRIVATE }] : [])], invitations: [],
          }
          else if (path === '/api/bots') value = isAlex && !alexBot ? [] : [{ id: isAlex ? ALEX_BOT : SMOKE_BOT,
            ownerId: wrongBotOwner ? PRIVATE : ownerId, workspaceId: TARGET.id, name: PRIVATE }]
          else if (path === '/api/version') value = { build: SHA }
          else if (path === '/api/rpc') {
            assert.equal(input.headers['x-mikka-rpc'], '1')
            const { action, args } = input.body
            state.actions.push(action)
            let result
            if (action === 'workspace.switchWorkspace') { assert.deepEqual(args, [TARGET.id]); selected = true; state.switches++
              result = { ok: true, data: { workspaceId: TARGET.id } } }
            else if (action === 'workspace-settings.getWorkspaceGeneral') { assert.deepEqual(args, [TARGET.id]);
              result = { id: TARGET.id, name: TARGET.name, slug: TARGET.slug, personal: false, canEdit: !isAlex, canTransfer: !isAlex } }
            else if (action === 'coordinator.syncCoordinatorChat') {
              assert.equal(isAlex, false); assert.deepEqual(args, [SMOKE_BOT]); state.chatReads++
              result = { chat: { botId: SMOKE_BOT, working: active, streamRunId: active ? TARGET.workflowRunId : null,
                items: [{ text: PRIVATE, from: 'coordinator', stopped: true }] } }
            } else if (action === 'model-order.getModelOrder') {
              assert.equal(isAlex, true); assert.deepEqual(args, [TARGET.id])
              if (unknownError) return Response.json({ ok: false, error: { code: PRIVATE, message: PRIVATE } }, { status: 500 })
              const entry = { harness: 'codex', model: 'gpt-6.1-sol', provider: 'codex',
                source: { kind: 'subscription', connectionId: 'ef66c1d8-2bbc-48e9-abf3-2ce3787ceef5' }, block: { reason: 'checking' }, label: PRIVATE }
              result = { entries: [entry], candidates: [entry], cloudReady: true, autoModelRouting: true, location: 'cloud',
                customized: false, preferredHarness: 'codex', credentials: 2, devices: [{ name: PRIVATE }] }
            } else if (action === 'personal-policy.getCreditShare') result = { mine: false, canShare: true, admin: false, sharers: [PRIVATE] }
            else if (action === 'personal-policy.getSubscriptionShare') result = { personal: false, shared: true, allowOthers: true, allowed: true,
              own: ['claude', 'codex'], available: [{ name: PRIVATE, provider: 'claude' }] }
            else if (action === 'personal-policy.getSharePolicy') result = { allowed: true, canEdit: false }
            else if (action === 'execution-settings.getBotModelMenu') {
              assert.equal(isAlex, true); assert.deepEqual(args, [ALEX_BOT]); state.menuReads++
              const option = { id: OPTION, modelId: 'gpt-6.1-sol', provider: 'codex' }
              result = { current: { ...option, kind: 'subscription', chosen: false, available: true, credentialLabel: PRIVATE },
                groups: [{ kind: 'hosted', points: 150, trialLeft: 0, options: [] },
                  { kind: 'subscription', provider: 'codex', owner: PRIVATE, plan: PRIVATE, credentialLabel: PRIVATE, options: [option] }] }
            } else assert.fail('mutating or unexpected RPC: ' + action)
            value = { ok: true, result }
          } else assert.fail('unexpected path: ' + path)
          requests.push({ path: '/mikka' + path.split('?')[0], method: input.body ? 'POST' : 'GET', status: 200, headersMs: 0 })
          return Response.json(value)
        } })
    } finally { state.signouts++; requests.push({ path: '/mikka/api/auth/sign-out', method: 'POST', status: 200, headersMs: 0 }) }
  }
  return { state, provider }
}

test('read-only sessions are separate; old Smoke chat is read once and no Alex bot is created', async () => {
  const smoke = accountFixture(TARGET.smokeOwner), alex = accountFixture(ALEX_OWNER_ID)
  const report = await observeAccounts({ smokeProvider: smoke.provider, alexProvider: alex.provider, checkpoint: false })
  assert.equal(report.status, 'observed', JSON.stringify(report))
  assert.equal(smoke.state.chatReads, 1); assert.equal(alex.state.chatReads, 0); assert.equal(alex.state.menuReads, 0)
  assert.equal(report.accounts[0].chat.idle, true)
  assert.equal(report.accounts[1].menu.status, 'not_observed_no_existing_bot')
  assert.equal(report.accounts[1].order.allCandidatesFromAuthorizedAlexSources, true)
  assert.equal(report.accounts[1].credits.personallyShared, false)
  assert.equal(smoke.state.signouts, 1); assert.equal(alex.state.signouts, 1)
  for (const key of ['taskCreationRequests', 'messageSendRequests', 'stopRequests', 'modelSelectionWrites', 'subscriptionOrCreditWrites']) assert.equal(report[key], 0)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('existing own bot permits a menu read with sanitized points and a real Codex option', async () => {
  const smoke = accountFixture(TARGET.smokeOwner), alex = accountFixture(ALEX_OWNER_ID, { alexBot: true })
  const report = await observeAccounts({ smokeProvider: smoke.provider, alexProvider: alex.provider, checkpoint: false })
  assert.equal(report.status, 'observed'); assert.equal(alex.state.menuReads, 1)
  assert.equal(report.accounts[1].menu.current.optionId, OPTION)
  assert.equal(report.accounts[1].menu.groups[0].points, 150)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('active Smoke is observed honestly, without any stop or repeated chat read', async () => {
  const smoke = accountFixture(TARGET.smokeOwner, { active: true }), alex = accountFixture(ALEX_OWNER_ID)
  const report = await observeAccounts({ smokeProvider: smoke.provider, alexProvider: alex.provider, checkpoint: false })
  assert.equal(report.accounts[0].chat.idle, false); assert.equal(report.accounts[0].chat.targetWorkflowActive, true)
  assert.equal(smoke.state.chatReads, 1); assert.equal(report.stopRequests, 0)
})

test('unexpected members and wrong bot owners fail closed before chat/menu; the other account still runs', async () => {
  for (const flags of [{ otherMember: true }, { wrongBotOwner: true }]) {
    const smoke = accountFixture(TARGET.smokeOwner, flags), alex = accountFixture(ALEX_OWNER_ID)
    const report = await observeAccounts({ smokeProvider: smoke.provider, alexProvider: alex.provider, checkpoint: false })
    assert.equal(report.status, 'incomplete'); assert.equal(report.accounts[0].status, 'failed')
    assert.equal(report.accounts[1].status, 'observed'); assert.equal(smoke.state.chatReads, 0)
    assert.equal(smoke.state.signouts, 1); assert.equal(alex.state.signouts, 1)
    assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  }
})

test('raw server failures are closed status/code metadata, with both sessions signed out', async () => {
  const smoke = accountFixture(TARGET.smokeOwner), alex = accountFixture(ALEX_OWNER_ID, { unknownError: true })
  const report = await observeAccounts({ smokeProvider: smoke.provider, alexProvider: alex.provider, checkpoint: false })
  assert.equal(report.status, 'incomplete'); assert.equal(report.accounts[1].error, 'acceptance_rpc_failed')
  assert.equal(report.accounts[1].httpStatus, 500); assert.equal(report.accounts[1].signedOut, true)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('Alex adapter consumes ACME credentials only, validates owner and uses a private cookie jar', async () => {
  const env = { ACME_DEMO_EMAIL: 'alex@example.test', ACME_DEMO_PASSWORD: PRIVATE,
    SMOKE_OWNER_EMAIL: 'wrong@example.test', SMOKE_OWNER_PASSWORD: 'WRONG_SMOKE_VALUE' }
  const calls = []
  const fetchImpl = async (url, input) => {
    calls.push({ path: url.pathname, cookie: input.headers.cookie })
    if (url.pathname.endsWith('/sign-in/email')) {
      assert.deepEqual(JSON.parse(input.body), { email: env.ACME_DEMO_EMAIL, password: PRIVATE })
      return Response.json({}, { headers: { 'set-cookie': 'session=PRIVATE_COOKIE; Path=/; Secure; HttpOnly' } })
    }
    assert.equal(input.headers.cookie, 'session=PRIVATE_COOKIE')
    if (url.pathname.endsWith('/get-session')) return Response.json({ user: { id: ALEX_OWNER_ID, email: env.ACME_DEMO_EMAIL } })
    if (url.pathname.endsWith('/version')) return Response.json({ build: SHA })
    if (url.pathname.endsWith('/sign-out')) return Response.json({ ok: true })
    assert.fail('unexpected request')
  }
  const requestMetadata = await alexSession(async session => {
    assert.equal(session.identity.userId, ALEX_OWNER_ID)
    return session.requests
  }, { env, fetchImpl, expectedSha: SHA })
  assert.equal(calls[0].cookie, undefined); assert.equal(calls.at(-1).path, '/mikka/api/auth/sign-out')
  assert.equal(JSON.stringify(requestMetadata).includes(PRIVATE), false)
  await assert.rejects(alexSession(() => assert.fail('work must not run'), { env: { SMOKE_OWNER_EMAIL: 'x@y.test', SMOKE_OWNER_PASSWORD: 'x' }, fetchImpl }), /alex_credentials_missing/)
})

test('wrong Alex owner is rejected before any callback and still signs out', async () => {
  let signedOut = 0
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith('/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'session=PRIVATE_COOKIE; Path=/' } })
    if (url.pathname.endsWith('/get-session')) return Response.json({ user: { id: TARGET.smokeOwner, email: 'alex@example.test' } })
    if (url.pathname.endsWith('/sign-out')) { signedOut++; return Response.json({ ok: true }) }
    assert.fail('work or version must not run')
  }
  await assert.rejects(alexSession(() => assert.fail('wrong identity callback'), {
    env: { ACME_DEMO_EMAIL: 'alex@example.test', ACME_DEMO_PASSWORD: PRIVATE }, fetchImpl,
  }), /acceptance_identity_mismatch/)
  assert.equal(signedOut, 1)
})

test('exact requested trace uses three finite metadata queries, with no invented workflow join', async () => {
  let calls = 0
  const report = await readTraces({ env: { POSTHOG_PERSONAL_API_KEY: 'phx_PRIVATE_CANARY' }, checkpoint: false,
    fetchImpl: async (url, input) => {
      assert.equal(url, 'https://us.posthog.com/api/projects/670821/query/')
      const query = QUERIES[calls++]
      const body = JSON.parse(input.body)
      assert.equal(body.query.query, query.sql)
      assert.equal(body.query.query.includes(TRACE.workflowRunId), false)
      assert.equal(body.query.query.includes('2026-11-06 19:12:15'), true)
      assert.equal(body.query.query.includes('2026-11-06 19:12:45'), true)
      const rows = query.name === 'exact_baseline_trace' ? [['2026-11-06 19:12:20', TRACE.traceId, 'a'.repeat(16),
        '/api/coordinator', 'coordinator.prepare_prompt', 200, 0]] : []
      return Response.json({ columns: query.columns, results: rows })
    } })
  assert.equal(calls, 3); assert.equal(report.status, 'observed'); assert.equal(report.targetTraceObserved, true)
  assert.equal(report.modelCacheCountersObserved, false); assert.equal(JSON.stringify(report).includes('phx_'), false)
})

test('a widened trace window makes no network request and HTTP failure is not retried', async () => {
  let calls = 0
  const env = { POSTHOG_PERSONAL_API_KEY: 'phx_PRIVATE_CANARY' }
  const widened = await readTraces({ env: { ...env, MIKKA_TRACE_UNTIL: '2026-11-06T20:12:45Z' }, checkpoint: false,
    fetchImpl: () => { calls++; assert.fail('widening must be rejected') } })
  assert.equal(widened.error, 'trace_window_invalid'); assert.equal(calls, 0)
  const failed = await readTraces({ env, checkpoint: false, fetchImpl: async () => { calls++; return new Response(PRIVATE, { status: 403 }) } })
  assert.equal(calls, 3); assert.equal(failed.status, 'incomplete'); assert.equal(failed.targetTraceObserved, false)
  assert.equal(JSON.stringify(failed).includes(PRIVATE), false)
})
