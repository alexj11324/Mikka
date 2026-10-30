import assert from 'node:assert/strict'
import test from 'node:test'
import { AUDIT_ACTIONS, AUDIT_SECRET_KEY_EXEMPT, AUDIT_CATEGORIES, AUDIT_METADATA, AuditEventError, auditCategory, auditRequestContext, isSecretBearingKey, looksLikeSecretValue, toAuditRow, type AuditEvent, type AuditMetadata } from './events'

const ws = '7b0f3c9e-2d4a-4e1b-9c3d-5f6a7b8c9d0e'
const base: AuditEvent = { workspaceId: ws, actor: { type: 'user', id: 'u1', name: 'Alex' }, action: 'member.removed', target: { type: 'member', id: 'u2', label: 'Mia' } }

test('every action maps to a known category and security is reachable', () => {
  for (const [action, category] of Object.entries(AUDIT_ACTIONS)) {
    assert.ok((AUDIT_CATEGORIES as readonly string[]).includes(category), action)
    assert.match(action, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  }
  assert.equal(auditCategory('token.created'), 'security')
  assert.equal(auditCategory('secret.replaced'), 'secret')
  assert.equal(auditCategory('member.role_changed'), 'member')
  assert.deepEqual(Object.keys(AUDIT_ACTIONS).filter(action => auditCategory(action as keyof typeof AUDIT_ACTIONS) === 'permission').sort(), ['bot.permissions_changed', 'integration.permission_changed', 'team.access_changed'])
  assert.deepEqual(new Set(Object.values(AUDIT_ACTIONS)), new Set(AUDIT_CATEGORIES))
})

test('toAuditRow snapshots names and derives category from action', () => {
  const row = toAuditRow({ ...base, action: 'member.role_changed', workspaceId: ws.toUpperCase(), ip: '203.0.113.4', geoCity: 'San Francisco', geoCountry: 'us', geoRegion: 'CA', metadata: { oldRole: 'member', newRole: 'admin' } })
  assert.deepEqual(row, { workspaceId: ws, actorType: 'user', actorId: 'u1', actorName: 'Alex', action: 'member.role_changed', category: 'member', targetType: 'member', targetId: 'u2', targetLabel: 'Mia', metadata: { oldRole: 'member', newRole: 'admin' }, ip: '203.0.113.4', geoCity: 'San Francisco', geoCountry: 'US', geoRegion: 'CA' })
})

test('system actor defaults its name; others need id and name', () => {
  assert.equal(toAuditRow({ ...base, actor: { type: 'system' } }).actorName, 'Mikka')
  assert.equal(toAuditRow({ ...base, actor: { type: 'system' } }).actorId, null)
  assert.throws(() => toAuditRow({ ...base, actor: { type: 'user', id: '', name: 'A' } }), AuditEventError)
  assert.throws(() => toAuditRow({ ...base, actor: { type: 'user', id: 'u', name: '  ' } }), /actorName/)
  assert.throws(() => toAuditRow({ ...base, actor: { type: 'robot' as 'user', id: 'u', name: 'A' } }), AuditEventError)
})

test('rejects bad workspace, unknown action and bad target', () => {
  assert.throws(() => toAuditRow({ ...base, workspaceId: 'nope' }), /uuid/)
  assert.throws(() => toAuditRow({ ...base, action: 'member.eaten' as 'member.invited' }), /unknown audit action/)
  assert.throws(() => toAuditRow({ ...base, action: 'toString' as 'member.invited' }), /unknown audit action/)
  assert.throws(() => toAuditRow({ ...base, target: { type: ' ' } }), /target type/)
  assert.deepEqual([toAuditRow({ ...base, target: null }).targetType, toAuditRow({ ...base, target: null }).targetLabel], [null, null])
})

test('metadata never carries secret-bearing keys, at any depth', () => {
  for (const key of ['value', 'Token', 'api_key', 'apiKey', 'password', 'client-secret', 'tokenHash'])
    assert.throws(() => toAuditRow({ ...base, metadata: { nested: [{ [key]: 'x' }] } }), /secret-bearing/, key)
  assert.doesNotThrow(() => toAuditRow({ ...base, action: 'secret.created', target: { type: 'secret', label: 'VERCEL_TOKEN' }, metadata: { scope: 'repo' } }))
  assert.throws(() => toAuditRow({ ...base, metadata: { blob: 'x'.repeat(5000) } }), /too large/)
  assert.throws(() => toAuditRow({ ...base, metadata: [] as unknown as Record<string, unknown> }), /object/)
})

test('labels are trimmed and clipped; invalid ip dropped', () => {
  const row = toAuditRow({ ...base, actor: { type: 'user', id: 'u1', name: '  Al\n ex ' }, target: { type: 'secret', label: 'x'.repeat(300) }, ip: 'not-an-ip' })
  assert.equal(row.actorName, 'Al ex')
  assert.equal(row.targetLabel?.length, 200)
  assert.equal(row.ip, null)
})

test('auditRequestContext reads first forwarded ip and decoded Vercel city (on Vercel only)', () => {
  const vercel = { VERCEL: '1' }
  const h = new Headers({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1', 'x-vercel-ip-city': 'San%20Francisco' })
  h.set('x-vercel-ip-country', 'US'); h.set('x-vercel-ip-country-region', 'CA')
  assert.deepEqual(auditRequestContext(h, vercel), { ip: '203.0.113.4', geoCity: 'San Francisco', geoCountry: 'US', geoRegion: 'CA' })
  assert.deepEqual(auditRequestContext(new Headers({ 'x-real-ip': '2001:db8::1' }), vercel), { ip: null, geoCity: null, geoCountry: null, geoRegion: null })
  assert.deepEqual(auditRequestContext(new Headers({ 'x-forwarded-for': '2001:db8::1', 'x-vercel-ip-country': 'US' }), vercel), { ip: '2001:db8::1', geoCity: null, geoCountry: 'US', geoRegion: null })
  assert.deepEqual(auditRequestContext(new Headers({ 'x-forwarded-for': 'garbage', 'x-vercel-ip-city': '%E0', 'x-vercel-ip-country': 'USA', 'x-vercel-ip-country-region': 'C-A' }), vercel), { ip: null, geoCity: '%E0', geoCountry: null, geoRegion: null })
  // Off Vercel the headers are client-forgeable: no ip, no geo.
  for (const env of [{}, { VERCEL: '0' }, { VERCEL: 'true' }]) assert.deepEqual(auditRequestContext(h, env), { ip: null, geoCity: null, geoCountry: null, geoRegion: null })
})

test('billing is prepaid credits: no plan or subscription actions, secret.deleted kept', () => {
  for (const action of ['billing.plan_changed', 'billing.subscription_canceled']) {
    assert.equal(action in AUDIT_ACTIONS, false)
    assert.throws(() => toAuditRow({ workspaceId: '00000000-0000-4000-8000-000000000001', actor: { type: 'system' }, action } as unknown as AuditEvent), AuditEventError)
  }
  assert.equal(AUDIT_ACTIONS['billing.credits_purchased'], 'billing')
  assert.equal(AUDIT_ACTIONS['secret.deleted'], 'secret')
})

// QA's 19 mutated keys (Tech Lead, 2026-10-29) plus separator/case mutations of each rule.
const MUTATED_SECRET_KEYS = [
  'githubToken', 'stripeSecretKey', 'webhookSecret', 'secretKey', 'sessionToken', 'bearer', 'credential', 'credentials', 'passwd', 'pwd',
  'jwt', 'setCookie', 'x-api-key', 'accessKey', 'privateKeyPem', 'signingSecret', 'dsn', 'connectionString', 'otp',
  'Value', 'plain_text', 'access-token', 'REFRESH_TOKEN', 'clientSecret', 'db_passwd', 'userPwd', 'api.key', 'awsCredentials',
  'id_jwt', 'Bearer', 'set-cookie', 'SENTRY_DSN', 'connection_string', 'PRIVATE-KEY', 'aws_secret_access_key', 'otp_code',
  'stripeKey', 'webhook-signing-key', 'Authorization', 'proxy_authorization', 'x-auth', 'authHeader', 'basic_auth', 'auth_code',
]
// Tech Lead's false-positive list: describe a secret but cannot hold one.
const ALLOWED_KEYS = [
  'idempotencyKey', 'primaryKey', 'otpEnabled', 'footprint', 'oauth', 'pan',
  'author', 'authorName', 'author_id', 'name', 'kind', 'scope', 'from', 'to', 'monkeys_count', 'keyword', 'keyPrefix',
]
// Strong secret words reject even with a safe suffix (Tech Lead, #432 round 3).
const STRONG_SUFFIXED_KEYS = [
  'tokenValueName', 'apiKeyPrefix', 'secretKeyId', 'passwordId', 'accessTokenCount', 'sessionTokenChanged', 'token_name',
  'secretName', 'tokenName', 'tokenId', 'tokenCount', 'passwordChanged', 'secretLabel', 'privateKeyLabel', 'API_KEY_ENABLED',
]

test('reject list: every rule, with separator and case mutations', () => {
  for (const key of MUTATED_SECRET_KEYS) assert.throws(() => toAuditRow({ ...base, metadata: { deep: { [key]: 'x' } } }), /secret-bearing key/, key)
  for (const key of ALLOWED_KEYS) assert.equal(isSecretBearingKey(key), false, key)
  for (const key of STRONG_SUFFIXED_KEYS) {
    assert.equal(isSecretBearingKey(key), true, key)
    assert.throws(() => toAuditRow({ ...base, metadata: { [key]: 'x' } }), /secret-bearing key/, key)
  }
})

test('per-action exemption: token.created may carry tokenName, nothing else may', () => {
  const token = { ...base, action: 'token.created' as const }
  assert.equal(toAuditRow({ ...token, metadata: { tokenName: 'CI deploy' } }).metadata.tokenName, 'CI deploy')
  assert.throws(() => toAuditRow({ ...token, metadata: { tokenId: 'x' } }), /secret-bearing key/)
  assert.throws(() => toAuditRow({ ...token, metadata: { token_name: 'x' } }), /secret-bearing key/)
  assert.throws(() => toAuditRow({ ...base, action: 'token.revoked', metadata: { tokenName: 'x' } }), /secret-bearing key/)
  assert.throws(() => toAuditRow({ ...base, action: 'secret.created', metadata: { tokenName: 'x' } }), /secret-bearing key/)
  // the exemption covers the key only; its value is still scanned
  assert.throws(() => toAuditRow({ ...token, metadata: { tokenName: 'gh~p_abcdefghijklmnopqrstuvwxyz0123456789'.replace('~', '') } }), /secret-bearing value/)
})

test('network_policy host counts are bounded ints', () => {
  const np = { ...base, action: 'network_policy.updated' as const }
  assert.doesNotThrow(() => toAuditRow({ ...np, metadata: { addedHosts: 0, removedHosts: 1000 } }))
  for (const bad of [-1, 1001, 1.5]) assert.throws(() => toAuditRow({ ...np, metadata: { addedHosts: bad } }), /allowlist/, String(bad))
})

// One sample per credential pattern (Tech Lead's examples included). Fake, non-working values.
// '~' keeps push-protection scanners off these fake samples; it is removed before use.
const SECRET_VALUES = [
  'sk~_live_FAKEFAKEFAKEFAKEFAKE00', 'token=sk~_live_FAKEFAKEFAKEFAKEFAKE00', 'rk~_test_FAKEFAKEFAKEFAKE00',
  'sk~-proj-abcdefghijklmnopqrstuvwx123', 'sk~-abcdefghijklmnopqrstuvwxyz0123',
  'gh~p_abcdefghijklmnopqrstuvwxyz0123456789', 'gh~o_abcdefghijklmnopqrstuv', 'gi~thub_pat_11ABCDEFG0abcdefghijklmn',
  'gl~pat-abcdefghijklmnopqrst', 'xo~xb-123456789012-abcdefghij', 'xa~pp-1-A0123456789-abcdef0123',
  'wh~sec_abcdefghijklmnop1234', 'AK~IAIOSFODNN7EXAMPLE', 'AI~zaSyA1234567890abcdefghijklmnopqrstuv', 'np~m_abcdefghijklmnopqrstuvwxyz0123456789',
  'ey~JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  '--~---BEGIN PRIVATE KEY-----', 'Au~thorization: Bearer abcdefghijklmnop1234', 'po~stgres://app:hunter2@db.example.com/mikka', 'ht~tps://user:pass@example.com',
  '--~---BEGIN PGP PRIVATE KEY BLOCK-----', 'Au~thorization: Basic dXNlcjpodW50ZXIy', 'ba~sic YWRtaW46c2VjcmV0cGFzcw==', 'id~_Bearer abcdefghijklmnop1234',
].map(sample => sample.replaceAll('~', ''))
const SAFE_VALUES = ['Eyjafjallajokull', 'xoxo hugs', 'sk_', 'skip', 'ghost', 'task-runner', 'Bearer of good news', 'https://example.com/a@b', 'VERCEL_TOKEN', 'AKIA', 'mailto:me@example.com', 'Basic plan', 'basic setup guide', 'Basic SGVsbG9Xb3JsZA==', '-----BEGIN PGP PUBLIC KEY BLOCK-----']

test('credential-shaped values are rejected anywhere in a string; look-alikes pass', () => {
  for (const value of SECRET_VALUES) assert.throws(() => toAuditRow({ ...base, action: 'workspace.slug_changed', metadata: { from: 'a', to: `x ${value}` } }), /secret-bearing value/, value)
  for (const value of SAFE_VALUES) assert.equal(looksLikeSecretValue(value), false, value)
  assert.doesNotThrow(() => toAuditRow({ ...base, action: 'workspace.slug_changed', metadata: { from: 'Eyjafjallajokull', to: 'xoxo hugs' } }))
})

test('metadata is a per-action allowlist; every allowlisted key passes the blacklist', () => {
  for (const [action, schema] of Object.entries(AUDIT_METADATA))
    for (const key of Object.keys((schema as { shape: Record<string, unknown> }).shape)) {
      const exempt = AUDIT_SECRET_KEY_EXEMPT[action as keyof typeof AUDIT_ACTIONS]?.includes(key) ?? false
      assert.equal(isSecretBearingKey(key), exempt, `${action}.${key}`) // exempt keys are exactly the strong-word keys an action opts into
    }
  const ok: Array<[keyof typeof AUDIT_ACTIONS, Record<string, unknown>]> = [
    ['member.role_changed', { oldRole: 'member', newRole: 'admin' }],
    ['integration.permission_changed', { integration: 'Slack', capability: 'write', from: 'allow', to: 'deny' }],
    ['auth.signed_in', { newDevice: true, method: 'password' }],
  ]
  for (const [action, metadata] of ok) assert.deepEqual(toAuditRow({ ...base, action, metadata }).metadata, metadata, action)
  assert.equal(auditCategory('integration.permission_changed'), 'permission')
  assert.throws(() => toAuditRow({ ...base, action: 'member.role_changed', metadata: { oldRole: 'member', newRole: 'admin', note: 'x' } }), /allowlist.*unexpected note/)
  assert.throws(() => toAuditRow({ ...base, action: 'member.role_changed', metadata: { newRole: 'admin' } }), /allowlist/)
  assert.throws(() => toAuditRow({ ...base, action: 'auth.signed_in', metadata: { newDevice: 'yes', method: 'password' } }), /allowlist/)
  assert.throws(() => toAuditRow({ ...base, metadata: { anything: 1 } }), /allowlist for member.removed/)
  const typed: AuditMetadata<'integration.permission_changed'> = { integration: 'Slack', capability: 'write', from: 'allow', to: 'deny' }
  assert.ok(typed)
})
