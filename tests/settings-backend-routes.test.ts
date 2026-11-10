import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { before, mock, test } from 'node:test'
import { verifyStripeSignature } from '../lib/billing/stripe'
import { WorkspaceError } from '../lib/workspace-error'

class AuditExportError extends Error { constructor(readonly code: string, readonly status: number) { super(code) } }
let user: { id: string } | null = { id: 'admin' }
let sessionFailure: Error | null = null
let denied = false
let auditError: AuditExportError | null = null
let webhookError: Error | null = null
let webhookCalls = 0
let cardSetupCalls = 0
let cardCheckoutCalls = 0
const workspaceId = '11111111-1111-4111-8111-111111111111'
const secret = 'synthetic-stripe-webhook-secret'
const calls: unknown[][] = []
let auditRoute: typeof import('../app/api/workspaces/[workspaceId]/audit-log/route')
let stripeRoute: typeof import('../app/api/billing/stripe/route')
let settingsRoute: typeof import('../app/api/settings/[read]/route')
let switcherRoute: typeof import('../app/api/workspace/switcher/route')
const switcherResult = { workspace: { id: workspaceId }, accounts: [] }
const switcherCalls: unknown[][] = []
let switcherFailure: Error | null = null
const workspaceBotCalls: unknown[][] = []
let workspaceBotResult: unknown = { bots: [] }
let workspaceBotFailure: Error | null = null
const currentSession = new AsyncLocalStorage<string>()
const syntheticSessionId = 'synthetic-settings-session'
let sessionGate: Promise<void> = Promise.resolve()
let sessionReads = 0

before(async () => {
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => {
    if (sessionFailure) throw sessionFailure
    return user ? { user, session: { id: currentSession.getStore() ?? syntheticSessionId, userId: user.id } } : null
  } } } } })
  mock.module('next-intl/server', { namedExports: { getTranslations: async () => (key: string) => key } })
  mock.module('@/lib/workspace-switcher', { namedExports: { loadWorkspaceSwitcher: async (...args: unknown[]) => {
    switcherCalls.push(args)
    if (switcherFailure) throw switcherFailure
    return switcherResult
  } } })
  mock.module('@/lib/db/request-scope', { namedExports: { inDatabaseTransaction: () => false } })
  mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => { if (!user) throw new Error('authRequired'); return user } } })
  mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError, loadWorkspaceContext: async (requested?: string) => {
    if (requested && requested !== workspaceId) throw new WorkspaceError('workspaceAccessDenied')
    return { workspace: { id: workspaceId }, role: 'admin' }
  } } })
  mock.module('@/app/actions/account', { namedExports: {
    getPasswordStatus: () => { throw new Error('unexpected settings read') },
    listSessions: async () => { const id = currentSession.getStore(); sessionReads++; await sessionGate; return { sessions: [{ id, current: true }] } },
  } })
  mock.module('@/lib/audit/export', { namedExports: { AuditExportError, readAuditExportPage: async (...args: unknown[]) => {
    calls.push(args)
    if (auditError) throw auditError
    return { manifest: { id: workspaceId, count: 3 }, events: [{ id: 'second' }], nextOffset: 2 }
  }, createAuditExport: async (...args: unknown[]) => {
    calls.push(args)
    if (auditError) throw auditError
    if (denied) throw new WorkspaceError('workspaceAccessDenied')
    return { manifest: { id: workspaceId, count: 1, digest: '0'.repeat(64) }, events: [{ createdAt: '2026-10-30T00:00:00.000Z', actorName: '=SUM(1,2)', actorType: 'user', action: 'token.created', category: 'security', targetLabel: 'Token', ip: null, geoCity: null }] }
  } } })
  mock.module('@/lib/billing/service', { namedExports: { applyStripeEvent: async () => {
    webhookCalls++
    if (webhookError) throw webhookError
  } } })
  mock.module('@/lib/billing/stripe', { namedExports: { stripeConfig: () => ({ webhookSecret: secret }), verifyStripeSignature } })
  mock.module('@/lib/abuse/card', { namedExports: { applyCardSetup: async () => { cardSetupCalls++ }, applyCardCheckout: async () => { cardCheckoutCalls++ } } })
  // Exercise the existing GET adapter without loading unrelated settings
  // services. The Bot action retains its own auth/current-workspace checks.
  for (const [module, names] of Object.entries({
    '@/app/actions/preferences': ['getPreferences'],
    '@/app/actions/issue-prefix': ['getIssuePrefixState'],
    '@/app/actions/settings-activity': ['listSavedLogins'],
    '@/app/actions/workspace-settings': ['getWorkspaceDeletionImpact', 'getWorkspaceGeneral', 'getWorkspaceTransferTargets'],
    '@/app/actions/app-policy': ['getAppPolicy'],
    '@/app/actions/personal-policy': ['getSharePolicy'],
    '@/app/actions/workspace-secrets': ['getE2BKeyCapability', 'listSecrets'],
    '@/app/actions/usage': ['getUsage'],
    '@/app/actions/billing': ['cardVerificationStatus', 'getBilling', 'getCreditBilling'],
    '@/app/actions/audit-log': ['listAuditLog'],
    '@/app/actions/model-order': ['getModelOrder'],
    '@/app/actions/model-api-keys': ['getApiKeys'],
  })) mock.module(module, { namedExports: Object.fromEntries(names.map(name => [name, () => { throw new Error('unexpected settings read') }])) })
  mock.module('@/app/actions/bots', { namedExports: {
    listBots: () => { throw new Error('owner-only Bot list cannot replace workspace activity') },
    listWorkspaceBots: async (...args: unknown[]) => {
      workspaceBotCalls.push(args)
      if (workspaceBotFailure) throw workspaceBotFailure
      return workspaceBotResult
    },
  } })
  auditRoute = await import('../app/api/workspaces/[workspaceId]/audit-log/route')
  stripeRoute = await import('../app/api/billing/stripe/route')
  settingsRoute = await import('../app/api/settings/[read]/route')
  switcherRoute = await import('../app/api/workspace/switcher/route')
})

test('workspace switcher uses the authenticated session and keeps its successful response private', async () => {
  switcherCalls.length = 0
  const response = await switcherRoute.GET(new Request('https://mikka.example/api/workspace/switcher?userId=other'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), switcherResult)
  assert.deepEqual(switcherCalls, [[{ user, session: { id: syntheticSessionId, userId: 'admin' } }]])
})

test('workspace switcher refuses a missing session before reading workspace data', async () => {
  switcherCalls.length = 0
  user = null
  try {
    const response = await switcherRoute.GET(new Request('https://mikka.example/api/workspace/switcher'))
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'authRequired' })
    assert.equal(switcherCalls.length, 0)
  } finally { user = { id: 'admin' } }
})

test('workspace switcher keeps explicit workspace and membership refusals as 403', async () => {
  try {
    for (const code of ['workspaceAccessDenied', 'workspaceMembershipSuspended']) {
      switcherFailure = new WorkspaceError(code)
      const response = await switcherRoute.GET(new Request('https://mikka.example/api/workspace/switcher'))
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.deepEqual(await response.json(), { error: 'FeatureCopy.c_6a0f7116' })
    }
  } finally { switcherFailure = null }
})

test('workspace switcher does not turn database or unknown read failures into authority refusals', async t => {
  const logged = t.mock.method(console, 'error', () => undefined)
  try {
    for (const error of [new Error('Connection terminated unexpectedly'), new TypeError('private store detail'), new Error('workspaceAccessDenied')]) {
      switcherFailure = error
      logged.mock.resetCalls()
      const response = await switcherRoute.GET(new Request('https://mikka.example/api/workspace/switcher'))
      assert.equal(response.status, 500)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.deepEqual(await response.json(), { error: 'workspaceReadFailed' })
      assert.ok(logged.mock.calls.some(call => call.arguments[0] === 'Workspace switcher could not be loaded' && call.arguments[1] === error.name))
      assert.ok(logged.mock.calls.every(call => !JSON.stringify(call.arguments).includes(error.message)), 'logs must not expose error messages')
    }
  } finally { switcherFailure = null }
})

test('workspace switcher keeps an unknown session lookup failure retryable without reading workspace data', async t => {
  const logged = t.mock.method(console, 'error', () => undefined)
  switcherCalls.length = 0
  sessionFailure = new Error('private session store detail')
  try {
    const response = await switcherRoute.GET(new Request('https://mikka.example/api/workspace/switcher'))
    assert.equal(response.status, 500)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await response.json(), { error: 'workspaceReadFailed' })
    assert.equal(switcherCalls.length, 0)
    assert.ok(logged.mock.calls.every(call => !JSON.stringify(call.arguments).includes(sessionFailure!.message)), 'logs must not expose session-store messages')
  } finally { sessionFailure = null }
})

test('workspace-bots GET preserves the full workspace activity result and delegates scope to the existing action', async () => {
  workspaceBotCalls.length = 0
  workspaceBotFailure = null
  workspaceBotResult = { bots: [{ id: workspaceId, ownerId: 'another-member', status: 'running', runningThreads: 2 }] }
  const response = await settingsRoute.GET(new Request('https://mikka.example/api/settings/workspace-bots?workspace=untrusted&userId=other'),
    { params: Promise.resolve({ read: 'workspace-bots' }) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), workspaceBotResult)
  assert.deepEqual(workspaceBotCalls, [[]], 'no caller-supplied owner/workspace replaces the authenticated action context')
})

test('workspace-bots GET preserves auth and membership refusals and never substitutes an empty activity list', async () => {
  workspaceBotCalls.length = 0
  workspaceBotFailure = null
  for (const [error, status] of [['authRequired', 401], ['workspaceAccessDenied', 403], ['workspaceMembershipSuspended', 403]] as const) {
    workspaceBotResult = { error }
    const response = await settingsRoute.GET(new Request('https://mikka.example/api/settings/workspace-bots'),
      { params: Promise.resolve({ read: 'workspace-bots' }) })
    assert.equal(response.status, status, 'access refusals retain their HTTP status so the read cache cannot retry or retain private data')
    assert.deepEqual(await response.json(), { error })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
  }
  assert.equal(workspaceBotCalls.length, 3)
  workspaceBotFailure = new Error('private store failure')
  await assert.rejects(settingsRoute.GET(new Request('https://mikka.example/api/settings/workspace-bots'),
    { params: Promise.resolve({ read: 'workspace-bots' }) }), /private store failure/)
  workspaceBotFailure = null
  const callsBefore = workspaceBotCalls.length
  const unknown = await settingsRoute.GET(new Request('https://mikka.example/api/settings/unknown'),
    { params: Promise.resolve({ read: 'unknown' }) })
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: 'notFound' })
  assert.equal(workspaceBotCalls.length, callsBefore)
})

test('concurrent devices of one owner retain their own current-session marker', async () => {
  user = { id: 'admin' }; sessionReads = 0
  let release!: () => void
  sessionGate = new Promise(resolve => { release = resolve })
  const reads = ['device-a', 'device-b'].map(id => currentSession.run(id, () => settingsRoute.GET(
    new Request('https://mikka.example/api/settings/sessions'), { params: Promise.resolve({ read: 'sessions' }) })))
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sessionReads, 2, 'session-specific reads cannot join another device of the same account')
    release()
    const responses = await Promise.all(reads)
    assert.deepEqual(await Promise.all(responses.map(response => response.json())), ['device-a', 'device-b'].map(id => ({ sessions: [{ id, current: true }] })))
  } finally { release(); sessionGate = Promise.resolve(); await Promise.allSettled(reads) }
})

test('audit JSON resumes the same snapshot and preserves explicit export failures', async () => {
  user = { id: 'admin' }; denied = false; auditError = null
  const params = { params: Promise.resolve({ workspaceId }) }
  const response = await auditRoute.GET(new Request(`https://mikka.example/export?format=json&exportId=${workspaceId}&offset=1&limit=1`), params)
  assert.equal(response.status, 200)
  assert.deepEqual(calls.at(-1), ['admin', workspaceId, workspaceId, 1, 1])
  assert.deepEqual(await response.json(), { manifest: { id: workspaceId, count: 3 }, events: [{ id: 'second' }], nextOffset: 2 })
  assert.equal((await auditRoute.GET(new Request('https://mikka.example/export?format=json&offset=1'), params)).status, 400)
  assert.equal((await auditRoute.GET(new Request('https://mikka.example/export?format=json&limit=1001'), params)).status, 400)
  auditError = new AuditExportError('auditExportLimitExceeded', 413)
  const failed = await auditRoute.GET(new Request('https://mikka.example/export'), params)
  assert.equal(failed.status, 413)
  assert.deepEqual(await failed.json(), { error: 'auditExportLimitExceeded' })
  auditError = null
})

test('audit CSV requires a session and service authorization, preserves the workspace/filter, and escapes formulas', async () => {
  calls.length = 0
  const request = () => new Request(`https://mikka.example/api/workspaces/${workspaceId}/audit-log?filter=security`)
  const params = { params: Promise.resolve({ workspaceId }) }
  user = null
  assert.equal((await auditRoute.GET(request(), params)).status, 401)
  assert.equal(calls.length, 0)
  user = { id: 'admin' }
  denied = true
  assert.equal((await auditRoute.GET(request(), params)).status, 404)
  denied = false
  const response = await auditRoute.GET(request(), params)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(calls.at(-1), ['admin', workspaceId, 'security'])
  assert.match(await response.text(), /"'=SUM\(1,2\)"/)
  // A narrower export: some categories in a shorter period, passed on as asked.
  const from = '2026-10-01T00:00:00.000Z', until = '2026-10-08T00:00:00.000Z'
  assert.equal((await auditRoute.GET(new Request(`https://mikka.example/export?filter=all&category=secret,member&from=${from}&until=${until}`), params)).status, 200)
  assert.deepEqual(calls.at(-1), ['admin', workspaceId, 'all', undefined, undefined, undefined, { categories: ['secret', 'member'], from, until }])
  const before = calls.length
  assert.equal((await auditRoute.GET(new Request('https://mikka.example/export?filter=invalid'), params)).status, 400)
  assert.equal((await auditRoute.GET(new Request('https://mikka.example/export?category=nope'), params)).status, 400)
  assert.equal((await auditRoute.GET(new Request(`https://mikka.example/export?from=${until}&until=${from}`), params)).status, 400)
  assert.equal((await auditRoute.GET(request(), { params: Promise.resolve({ workspaceId: 'not-a-uuid' }) })).status, 404)
  assert.equal(calls.length, before)
})

test('Stripe webhook verifies raw-body signatures before applying an event and leaves DB failures retryable', async () => {
  webhookCalls = 0
  const body = JSON.stringify({ id: 'evt_synthetic', type: 'test.event', data: { object: {} } })
  const request = (value: string, valid = true) => {
    const timestamp = Math.floor(Date.now() / 1000)
    const digest = createHmac('sha256', secret).update(`${timestamp}.${value}`).digest('hex')
    return new Request('https://mikka.example/api/billing/stripe', { method: 'POST', body: value, headers: { 'stripe-signature': `t=${timestamp},v1=${valid ? digest : '0'.repeat(64)}` } })
  }
  assert.equal((await stripeRoute.POST(request(body, false))).status, 400)
  assert.equal(webhookCalls, 0)
  assert.equal((await stripeRoute.POST(request(body))).status, 200)
  assert.equal(webhookCalls, 1)
  assert.equal((await stripeRoute.POST(request('{invalid'))).status, 400)
  assert.equal(webhookCalls, 1)
  webhookError = new Error('isolated database failure')
  await assert.rejects(stripeRoute.POST(request(body)), /isolated database failure/)
  webhookError = null
})

test('signed setup Checkout events and legacy SetupIntents reach verification; invalid signatures do not', async () => {
  cardSetupCalls = 0
  cardCheckoutCalls = 0
  const request = (type: string, object: unknown, valid = true) => {
    const body = JSON.stringify({ id: 'evt_card_fixture', type, data: { object } })
    const timestamp = Math.floor(Date.now() / 1000)
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    return new Request('https://mikka.example/api/billing/stripe', { method: 'POST', body, headers: { 'stripe-signature': `t=${timestamp},v1=${valid ? digest : '0'.repeat(64)}` } })
  }
  assert.equal((await stripeRoute.POST(request('checkout.session.completed', { mode: 'setup' }, false))).status, 400)
  assert.equal(cardCheckoutCalls, 0)
  assert.equal((await stripeRoute.POST(request('checkout.session.completed', { mode: 'setup' }))).status, 200)
  assert.equal(cardCheckoutCalls, 1)
  assert.equal((await stripeRoute.POST(request('setup_intent.succeeded', {}))).status, 200)
  assert.equal(cardSetupCalls, 1)
})
