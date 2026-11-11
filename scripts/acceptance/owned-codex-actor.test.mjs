import assert from 'node:assert/strict'
import test from 'node:test'
import { ownedCodexAccount, selectOwnedCodexWorkspace, OWNED_CODEX_ACTOR } from './owned-codex-actor.mjs'

const ownerId = 'authorized-owner', personal = '10000000-0000-4000-8000-000000000001', team = '10000000-0000-4000-8000-000000000002'
const email = 'alexjiang20232024@gmail.com'

test('the separately authorized Codex actor requires its complete exact account pair, without a SMOKE fallback', () => {
  assert.equal(OWNED_CODEX_ACTOR, 'authorized_2023_codex')
  assert.deepEqual(ownedCodexAccount({ MIKKA_TEST_ACCOUNT_EMAIL: email, MIKKA_TEST_ACCOUNT_PASSWORD: 'synthetic' }), { email, password: 'synthetic' })
  for (const env of [{ SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: 'synthetic' },
    { MIKKA_TEST_ACCOUNT_EMAIL: email, SMOKE_OWNER_PASSWORD: 'synthetic' },
    { MIKKA_TEST_ACCOUNT_EMAIL: 'other@example.invalid', MIKKA_TEST_ACCOUNT_PASSWORD: 'synthetic' }]) {
    assert.throws(() => ownedCodexAccount(env), /startup_owned_account_required/)
  }
})

test('the owned actor selects and verifies its unique personal workspace through normal session APIs', async () => {
  let selected = team, original
  const calls = []
  const view = id => ({ currentUserId: ownerId, workspace: { id, kind: id === personal ? 'personal' : 'team' }, role: 'admin',
    choices: [{ id: personal, kind: 'personal' }, { id: team, kind: 'team' }],
    members: [{ userId: ownerId, role: 'admin', status: 'active' }] })
  const client = { json: async path => {
    calls.push(path)
    if (path === '/api/auth/get-session') return { user: { id: ownerId, email } }
    return view(path.includes('?workspace=') ? path.split('=')[1] : selected)
  }, rpc: async (action, args) => {
    assert.equal(action, 'workspace.switchWorkspace'); assert.deepEqual(args, [personal]); selected = personal
    return { workspaceId: personal }
  } }
  const scope = await selectOwnedCodexWorkspace(client, { ownerId }, value => { original = value })
  assert.equal(original, team)
  assert.equal(scope.actor, OWNED_CODEX_ACTOR); assert.equal(scope.ownerId, ownerId); assert.equal(scope.workspaceId, personal)
  assert.equal(scope.evidence.kind, 'personal'); assert.match(scope.evidence.workspaceHash, /^[a-f0-9]{64}$/)
  assert.equal(scope.adminId, undefined)
  assert.deepEqual(calls, ['/api/workspace', '/api/workspace?workspace=' + personal, '/api/workspace', '/api/auth/get-session'])
  assert.doesNotMatch(JSON.stringify(scope.evidence), /authorized-owner|alexjiang|adminId|teamWorkspace/)
})

test('an owned workspace cannot be replaced by a foreign membership, email or requested workspace', async () => {
  const base = { currentUserId: ownerId, workspace: { id: personal, kind: 'personal' }, role: 'admin',
    choices: [{ id: personal, kind: 'personal' }], members: [{ userId: ownerId, role: 'admin', status: 'active' }] }
  for (const change of [{ currentUserId: 'foreign' }, { members: [{ userId: 'foreign', role: 'admin', status: 'active' }] }, { role: 'member' }]) {
    const client = { json: async () => ({ ...base, ...change }), rpc: () => assert.fail('must not switch') }
    await assert.rejects(selectOwnedCodexWorkspace(client, { ownerId }), /startup_owned_workspace_mismatch/)
  }
  const client = { json: async path => path.endsWith('get-session') ? { user: { id: ownerId, email: 'foreign@example.invalid' } } : base }
  await assert.rejects(selectOwnedCodexWorkspace(client, { ownerId }), /startup_session_identity_mismatch/)
  await assert.rejects(selectOwnedCodexWorkspace(client, { ownerId, workspace: team }), /startup_owned_workspace_mismatch/)
})
