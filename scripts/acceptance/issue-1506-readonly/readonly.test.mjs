// Offline fixtures only: no default network, no Smoke login and no chat reads.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ALEX_OWNER_ID, alexSession } from './alex-session.mjs'
import { observeAccounts, TARGET } from './accounts-readonly.mjs'
import { QUERIES, readTraces, TRACE } from './coordinator-traces.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const SHA = '3fbb10efeddb57656284d561e814b8f8d41e76fe'
const ALEX_BOT = '11111111-1111-4111-8111-111111111111'
const OPTION = '22222222-2222-4222-8222-222222222222'
const PRIVATE = 'PRIVATE_CANARY_MUST_NOT_APPEAR'

function accountFixture({ alexBot = false, otherMember = false, wrongBotOwner = false, wrongPersonal = false, unknownError = false } = {}) {
  const state = { menuReads: 0, switches: 0, signouts: 0, actions: [], reads: [] }
  const requests = []
  let selected = false
  const provider = async (work, options) => {
    assert.equal(options.expectedSha, null)
    try {
      return await work({ identity: { userId: ALEX_OWNER_ID }, version: { build: SHA }, requests,
        async request(path, input = {}) {
          state.reads.push(path)
          let value
          if (path === '/api/workspace/switcher') value = { workspace: { id: selected ? TARGET.id : 'previous' },
            accounts: [{ id: ALEX_OWNER_ID, email: PRIVATE, choices: [
              { id: wrongPersonal ? '99999999-9999-4999-8999-999999999999' : TARGET.id, name: PRIVATE, kind: 'personal' },
              { id: '33333333-3333-4333-8333-333333333333', name: PRIVATE, kind: 'team' },
            ] }] }
          else if (path === '/api/workspace?workspace=' + TARGET.id) value = {
            workspace: { id: TARGET.id, kind: 'personal', name: PRIVATE }, currentUserId: ALEX_OWNER_ID, role: 'admin',
            members: [{ userId: ALEX_OWNER_ID, role: 'admin', status: 'active', name: PRIVATE, email: PRIVATE },
              ...(otherMember ? [{ userId: PRIVATE, role: 'member', status: 'active', email: PRIVATE }] : [])], invitations: [],
          }
          else if (path === '/api/bots') value = !alexBot ? [] : [{ id: ALEX_BOT,
            ownerId: wrongBotOwner ? PRIVATE : ALEX_OWNER_ID, workspaceId: TARGET.id, name: PRIVATE }]
          else if (path === '/api/version') value = { build: SHA }
          else if (path === '/api/rpc') {
            assert.equal(input.headers['x-mikka-rpc'], '1')
            const { action, args } = input.body
            state.actions.push(action)
            let result
            if (action === 'workspace.switchWorkspace') { assert.deepEqual(args, [TARGET.id]); selected = true; state.switches++
              result = { ok: true, data: { workspaceId: TARGET.id } } }
            else if (action === 'workspace-settings.getWorkspaceGeneral') { assert.deepEqual(args, [TARGET.id]);
              result = { id: TARGET.id, name: PRIVATE, slug: PRIVATE, personal: true, canEdit: true, canTransfer: false } }
            else if (action === 'model-order.getModelOrder') {
              assert.deepEqual(args, [TARGET.id])
              if (unknownError) return Response.json({ ok: false, error: { code: PRIVATE, message: PRIVATE } }, { status: 500 })
              const entry = { harness: 'codex', model: 'gpt-6-luna', provider: 'codex',
                source: { kind: 'subscription', connectionId: '6223f3e1-d626-4eb7-ab62-34dcf3fbfd0c' }, block: { reason: 'checking' }, label: PRIVATE }
              result = { entries: [entry], candidates: [entry], cloudReady: true, autoModelRouting: true, location: 'cloud',
                customized: false, preferredHarness: 'codex', credentials: 2, devices: [{ name: PRIVATE }] }
            } else if (action === 'personal-policy.getCreditShare') result = { mine: false, canShare: false, admin: true, sharers: [PRIVATE] }
            else if (action === 'personal-policy.getSubscriptionShare') result = { personal: true, shared: true, allowOthers: false, allowed: true,
              own: [], available: [] }
            else if (action === 'personal-policy.getSharePolicy') result = { allowed: true, canEdit: false }
            else if (action === 'execution-settings.getBotModelMenu') {
              assert.deepEqual(args, [ALEX_BOT]); state.menuReads++
              const option = { id: OPTION, modelId: 'gpt-6-luna', provider: 'codex' }
              result = { current: { ...option, kind: 'subscription', chosen: false, available: true, credentialLabel: PRIVATE },
                groups: [{ kind: 'hosted', points: 150, trialLeft: 0, options: [] },
                  { kind: 'subscription', provider: 'codex', owner: PRIVATE, plan: PRIVATE, credentialLabel: PRIVATE, options: [option] }] }
            } else assert.fail('chat, mutation or unexpected RPC: ' + action)
            value = { ok: true, result }
          } else assert.fail('unexpected path: ' + path)
          requests.push({ path: '/mikka' + path.split('?')[0], method: input.body ? 'POST' : 'GET', status: 200, headersMs: 0 })
          return Response.json(value)
        } })
    } finally { state.signouts++; requests.push({ path: '/mikka/api/auth/sign-out', method: 'POST', status: 200, headersMs: 0 }) }
  }
  return { state, provider }
}

test('only the real ACME owner personal workspace is observed, with zero Smoke/chat calls or implicit bot creation', async () => {
  assert.equal(ALEX_OWNER_ID, 'OFtPbAHifGBAOYiek9hd3w')
  const alex = accountFixture()
  const report = await observeAccounts({ alexProvider: alex.provider, checkpoint: false })
  assert.equal(report.status, 'observed', JSON.stringify(report))
  assert.equal(report.accounts.length, 1); assert.equal(report.smokeSessionAttempts, 0)
  assert.equal(report.accounts[0].chatReads, 0); assert.equal(alex.state.menuReads, 0)
  assert.equal(report.accounts[0].menu.status, 'not_observed_no_existing_bot')
  assert.equal(report.accounts[0].order.allCandidatesFromAuthorizedAlexSources, true)
  assert.equal(report.accounts[0].workspace.kind, 'personal')
  assert.equal(alex.state.signouts, 1)
  for (const key of ['taskCreationRequests', 'messageSendRequests', 'stopRequests', 'modelSelectionWrites', 'subscriptionOrCreditWrites']) assert.equal(report[key], 0)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('an existing own bot permits one metadata menu read with points and a real Codex option', async () => {
  const alex = accountFixture({ alexBot: true })
  const report = await observeAccounts({ alexProvider: alex.provider, checkpoint: false })
  assert.equal(report.status, 'observed'); assert.equal(alex.state.menuReads, 1)
  assert.equal(report.accounts[0].menu.current.optionId, OPTION)
  assert.equal(report.accounts[0].menu.groups[0].points, 150)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('a different personal workspace is rejected rather than falling back to an existing team', async () => {
  const alex = accountFixture({ wrongPersonal: true })
  const report = await observeAccounts({ alexProvider: alex.provider, checkpoint: false })
  assert.equal(report.status, 'incomplete'); assert.equal(report.accounts[0].error, 'workspace_target_missing')
  assert.equal(alex.state.switches, 0); assert.equal(alex.state.menuReads, 0); assert.equal(alex.state.signouts, 1)
})

test('unexpected members or wrong bot owners fail closed before reading model menus', async () => {
  for (const flags of [{ otherMember: true }, { alexBot: true, wrongBotOwner: true }]) {
    const alex = accountFixture(flags)
    const report = await observeAccounts({ alexProvider: alex.provider, checkpoint: false })
    assert.equal(report.status, 'incomplete'); assert.equal(report.accounts[0].status, 'failed')
    assert.equal(alex.state.menuReads, 0); assert.equal(alex.state.signouts, 1)
    assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  }
})

test('raw server failure is closed status/code metadata and the ACME session signs out', async () => {
  const alex = accountFixture({ unknownError: true })
  const report = await observeAccounts({ alexProvider: alex.provider, checkpoint: false })
  assert.equal(report.status, 'incomplete'); assert.equal(report.accounts[0].error, 'acceptance_rpc_failed')
  assert.equal(report.accounts[0].httpStatus, 500); assert.equal(report.accounts[0].signedOut, true)
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
    if (url.pathname.endsWith('/get-session')) return Response.json({ user: { id: 'XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ', email: 'alex@example.test' } })
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

test('personal token shape is diagnostic only; empty/public project tokens never make a request', async () => {
  for (const key of ['', '   ', 'phc_PUBLIC_PROJECT_TOKEN']) {
    let calls = 0
    const report = await readTraces({ env: { POSTHOG_PERSONAL_API_KEY: key }, checkpoint: false,
      fetchImpl: () => { calls++; assert.fail('nonpersonal or missing token must not be sent') } })
    assert.equal(calls, 0); assert.equal(report.status, 'incomplete')
    assert.deepEqual(Object.keys(report.credentialShape).sort(), ['exists', 'hasWhitespace', 'length', 'startsPhx'])
  }
  const key = '  phx_SYNTHETIC+slash/=  '
  let calls = 0
  const report = await readTraces({ env: { POSTHOG_PERSONAL_API_KEY: key }, checkpoint: false,
    fetchImpl: async (_url, input) => {
      assert.equal(input.headers.authorization, 'Bearer ' + key.trim())
      return Response.json({ columns: QUERIES[calls++].columns, results: [] })
    } })
  assert.equal(calls, 3); assert.equal(report.status, 'observed')
  assert.deepEqual(report.credentialShape, { exists: true, startsPhx: false, hasWhitespace: true, length: key.length })
  assert.equal(JSON.stringify(report).includes('SYNTHETIC'), false)
})
