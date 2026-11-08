import assert from 'node:assert/strict'
import { test } from 'node:test'
import { interruptedFixtures, recoverInterruptedLeaseAudit } from './cloud-lease-recovery.mjs'

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = 'synthetic-owner', workspaceId = id(1), personal = id(2), botId = id(3)
const time = '2026-11-07T22:23:00.000Z'
const identity = { user: { id: owner, email: 'owner@example.invalid' }, session: { id: 'current-session', token: 'CURRENT_PRIVATE' } }
const profile = (harness, n) => ({ id: id(n), name: '测试1505 1234abcd ' + harness,
  description: 'Temporary startup measurement', harness, enabled: true, version: 1,
  createdAt: time, updatedAt: time, archivedAt: null,
  model: { mode: 'fixed', harness, model: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', source: { kind: 'subscription' } } })
const fixture = () => ({ identity, workspaceId, profiles: [profile('claude_code', 4), profile('codex', 5)],
  bots: { items: [{ id: botId, name: '测试1505 1234abcd' }], live: { ownerId: owner, workspaceId } },
  sessions: [{ id: 'old-session', userId: owner, token: 'OLD_PRIVATE'.repeat(4), userAgent: 'node', createdAt: time, updatedAt: time }] })
const sha = 'a'.repeat(40)
const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: sha, APPLICATION_SHA: sha, LEASE_AUDIT_RECOVERY_RUN: '42418118236' }

test('recovery selects only the exact interrupted time, fixture prefix, small subscriptions and own old session', () => {
  const input = fixture()
  input.profiles.push({ ...profile('codex', 9), createdAt: '2026-11-07T22:24:00Z' })
  input.sessions.push({ ...input.sessions[0], id: 'unrelated', createdAt: '2026-11-07T22:24:00Z' })
  const selected = interruptedFixtures(input)
  assert.equal(selected.botId, botId); assert.equal(selected.profiles.length, 2); assert.equal(selected.sessions.length, 1)
})
test('changed, ambiguous, foreign, currently used and outside-window fixtures refuse before any recovery write', () => {
  const changes = [
    f => { f.bots.live.workspaceId = personal }, f => { f.bots.live.ownerId = 'foreign' },
    f => { f.bots.items.push({ ...f.bots.items[0], id: id(8) }) },
    f => { f.profiles[0].version = 2 }, f => { f.profiles[0].updatedAt = '2026-11-07T22:24:00Z' },
    f => { f.profiles[0].name = '测试1505 ffffffff claude_code' },
    f => { f.profiles[0].model.source.kind = 'api_key' },
    f => { f.profiles[0].model.model = 'pro' }, f => { f.profiles[0].description = 'real work' },
    f => { f.sessions[0].userId = 'foreign' }, f => { f.sessions[0].id = identity.session.id },
    f => { f.sessions[0].token = identity.session.token }, f => { f.sessions[0].userAgent = 'browser' },
    f => { f.sessions[0].updatedAt = '2026-11-07T22:24:00Z' }, f => { f.sessions.push({ ...f.sessions[0], id: 'another' }) },
  ]
  for (const change of changes) { const value = fixture(); change(value); assert.throws(() => interruptedFixtures(value)) }
})
function dependencies({ failArchive = false, empty = false } = {}) {
  const own = fixture(), calls = [], archived = new Set()
  let revoked = false, cleared = false
  const client = {
    async request(path) { calls.push(path); return { ok: true } },
    async json(path, init) {
      calls.push(path)
      if (path === '/api/version') return { build: sha }
      if (path.startsWith('/api/auth/get-session')) return identity
      if (path === '/api/workspace') return { workspace: { id: personal } }
      if (path === '/api/auth/list-sessions') return revoked || empty ? [] : own.sessions
      if (path === '/api/auth/revoke-session') {
        assert.deepEqual(JSON.parse(init.body), { token: own.sessions[0].token }); revoked = true; return { status: true }
      }
      if (path.startsWith('/api/factory/agent-profiles?')) {
        assert.equal(path, '/api/factory/agent-profiles?workspaceId=' + workspaceId)
        return { profiles: empty ? [] : own.profiles }
      }
      const row = own.profiles.find(p => path.startsWith('/api/factory/agent-profiles/' + p.id))
      assert.ok(row, path)
      if (init?.method === 'DELETE') {
        assert.deepEqual(JSON.parse(init.body), { workspaceId, version: 1 })
        if (failArchive) throw Error('PRIVATE_PROVIDER_BODY')
        archived.add(row.id)
      }
      assert.ok(archived.has(row.id)); return { profile: { ...row, enabled: false, archivedAt: '2026-11-07T23:00:00Z' } }
    },
    async rpc(action, args) {
      calls.push(action)
      if (action === 'bots.pollBots') return own.bots
      assert.equal(action, 'workspace.switchWorkspace'); assert.deepEqual(args, [personal])
    },
    clear() { cleared = true },
  }
  return { calls, archived, cleared: () => cleared, deps: {
    makeClient: origin => { assert.equal(origin, 'https://app.aspectlylabs.com'); return client },
    account: () => ({ email: identity.user.email, password: 'PRIVATE_PASSWORD' }),
    selectTeam: async ({ onSelected }) => { await onSelected({ workspaceId }); return { teamWorkspaceConfirmed: true } },
  } }
}
test('normal recovery archives only its two profiles, revokes only its old session and retains the Bot', async () => {
  const f = dependencies(), result = await recoverInterruptedLeaseAudit(env, f.deps)
  assert.equal(result.botId, botId); assert.equal(result.evidence.status, 'passed')
  assert.equal(result.evidence.profilesArchived, 2); assert.equal(result.evidence.oldSessionsRevoked, 1)
  assert.deepEqual(result.evidence.cleanup, { workspaceRestored: true, ownSessionClosed: true })
  assert.equal(result.evidence.botRetention, 'retained_no_delete_api'); assert.ok(f.cleared())
  assert.equal(f.archived.size, 2)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|password|token/)
  assert.ok(f.calls.every(path => !/subscription|revoke-sessions|deleteBot|stopCoordinator|factory\/tasks/.test(path)))
})
test('recovery handles an already absent fixture without touching unrelated resources', async () => {
  const f = dependencies({ empty: true }), result = await recoverInterruptedLeaseAudit(env, f.deps)
  assert.equal(result.evidence.status, 'passed'); assert.equal(result.evidence.profilesArchived, 0)
  assert.equal(result.evidence.oldSessionsRevoked, 0); assert.equal(result.botId, undefined)
})
test('failed recovery stops, closes its new session, and returns only closed diagnostics', async () => {
  const f = dependencies({ failArchive: true }), result = await recoverInterruptedLeaseAudit(env, f.deps)
  assert.equal(result.evidence.status, 'failed'); assert.equal(result.botId, undefined)
  assert.equal(result.evidence.cleanup.ownSessionClosed, true); assert.ok(f.cleared())
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); assert.ok(!f.calls.includes('/api/auth/revoke-session'))
})
test('recovery target and known run are checked before account credentials or an HTTP client', async () => {
  const refuse = { makeClient: () => assert.fail('client before target guard'), account: () => assert.fail('credentials before target guard') }
  for (const changed of [{ LEASE_AUDIT_RECOVERY_RUN: 'arbitrary' }, { GITHUB_REF: 'refs/heads/branch' }, { GITHUB_SHA: 'b'.repeat(40) }]) {
    await assert.rejects(() => recoverInterruptedLeaseAudit({ ...env, ...changed }, refuse))
  }
})
