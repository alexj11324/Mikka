import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { TestAccountPool } from '../../../scripts/test-accounts/pool.mjs'
import { captureGeneratedWorkspaceName } from './generated-workspace-name.mjs'
import { recordNativeCleanup } from './native-auth-diagnostics.mjs'

const importOptions = { parentURL: import.meta.url, tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) }

const { defaultWorkspaceName, renameGeneratedWorkspace } = await tsImport('../../../lib/workspace-name.ts', importOptions)
const { encode, decode } = await tsImport('../../../lib/desktop-rpc/wire.ts', importOptions)
const OWNER = 'owner-test', PEER = 'peer-test', ID = '11111111-1111-4111-8111-111111111111'
const fingerprint = owned => {
  const hash = createHash('sha256')
  for (const [table, rows] of [...owned].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([table, rows.map(row => row.text)]))
  return hash.digest('hex')
}
const row = value => ({ value: structuredClone(value), text: JSON.stringify(value) })

function fixture() {
  const ownerName = 'Private fixture owner'
  const originalName = defaultWorkspaceName('zh-CN', ownerName)
  const englishName = defaultWorkspaceName('en', ownerName)
  const owner = new Map([
    ['user', [row({ id: OWNER, name: ownerName })]],
    ['mikka_workspaces', [row({ id: ID, userId: OWNER, kind: 'personal', name: originalName, slug: null })]],
    ['workspace_audit_events', []],
    ['resource_access_events', []],
  ])
  const peer = new Map([['user', [row({ id: PEER, name: 'Private peer' })]]])
  const events = []
  const retained = []
  const lease = { id: 'lease-test', generation: 1, pairId: 'pair-test' }
  const accounts = [
    { role: 'owner', user_id: OWNER, baseline: fingerprint(owner) },
    { role: 'peer', user_id: PEER, baseline: fingerprint(peer) },
  ]
  const replaceWorkspace = patch => owner.set('mikka_workspaces', [row({ ...owner.get('mikka_workspaces')[0].value, ...patch })])
  let responseFailure = false, changeAfterRestore = false
  const client = { async query(sql, args) {
    assert.match(sql, /^SELECT /)
    if (sql.includes('FROM mikka_test_accounts.accounts')) return { rows: structuredClone(accounts) }
    if (sql.includes("to_regclass('mikka_test_accounts.retained_audit')")) return { rows: [{ receipts: 'mikka_test_accounts.retained_audit' }] }
    if (sql.includes('FROM mikka_test_accounts.retained_audit')) return { rows: args[0] === OWNER ? structuredClone(retained) : [] }
    assert.ok(sql.includes('jsonb_set(to_jsonb(w)'))
    assert.deepEqual(args, [ID, originalName, OWNER])
    return { rows: [{ data: JSON.stringify({ ...owner.get('mikka_workspaces')[0].value, name: args[1] }) }] }
  } }
  const pool = Object.assign(Object.create(TestAccountPool.prototype), {
    async current(_client, value, options) { assert.equal(value.id, lease.id); assert.equal(value.generation, lease.generation); assert.deepEqual(options, { readOnly: true, requireUnexpired: true }) },
    async transaction(work, options) { assert.equal(options?.readOnly, true); return work(client) },
    async ownedRows(_client, id) { return structuredClone(id === OWNER ? owner : peer) },
    async revokeSessions(value) { assert.equal(value.id, lease.id); events.push('revoke'); owner.set('workspace_audit_events', []) },
  })
  const scope = {
    pool, lease, async assertActive() {},
    owner: {
      userId: OWNER,
      async reauthenticate() { events.push('reauthenticate'); owner.set('workspace_audit_events', [row({ id: 'private-audit', action: 'auth.signed_in' })]) },
      async request(path, init) {
        events.push('request')
        assert.equal(path, '/api/rpc')
        assert.equal(init.method, 'POST')
        assert.deepEqual(init.headers, { 'content-type': 'application/json', 'x-mikka-rpc': '1', 'x-mikka-locale': 'zh-CN' })
        const body = JSON.parse(init.body)
        assert.equal(body.version, 1)
        assert.equal(body.action, 'workspace-settings.getWorkspaceGeneral')
        assert.deepEqual(decode(body.args), [ID])
        if (responseFailure) return Response.json({ version: 1, ok: false, error: { code: 'authRequired' } }, { status: 401 })
        const next = renameGeneratedWorkspace(owner.get('mikka_workspaces')[0].value.name, 'zh-CN', ownerName)
        assert.equal(next, originalName)
        replaceWorkspace({ name: next })
        const value = { id: ID, name: next, personal: true, canEdit: true }
        if (changeAfterRestore) replaceWorkspace({ slug: 'unexpected' })
        return Response.json({ version: 1, ok: true, result: encode(value) })
      },
    },
    peer: { userId: PEER },
  }
  return { scope, owner, peer, events, originalName, englishName, ownerName, replaceWorkspace, retained,
    failResponse() { responseFailure = true }, changeAfterRestore() { changeAfterRestore = true } }
}

test('restores only a proven localized generated name through normal authenticated RPC, then exact cleanup', async () => {
  const f = fixture(), helper = await captureGeneratedWorkspaceName(f.scope)
  f.replaceWorkspace({ name: f.englishName })
  const stages = []
  const result = await recordNativeCleanup('workspace-generated-name', () => helper.restore({ drained: true }), stages)
  assert.deepEqual(stages, [{ stage: 'workspace-generated-name', result: 'passed' }])
  assert.deepEqual(f.events, ['revoke', 'reauthenticate', 'request', 'revoke'])
  assert.equal(result.phase, 'restored')
  assert.deepEqual(result.initialName, { en: false, zhCN: true })
  assert.deepEqual(result.beforeName, { en: true, zhCN: false })
  assert.deepEqual(result.afterName, { en: false, zhCN: true })
  assert.equal(result.onlyGeneratedNameDifference, true)
  assert.equal(result.ownerMatchesSealedBaseline, true)
  assert.equal(result.peerMatchesSealedBaseline, true)
  const published = JSON.stringify(result)
  for (const privateValue of [OWNER, PEER, ID, f.ownerName, f.originalName, f.englishName, 'private-audit']) assert.equal(published.includes(privateValue), false)
})

test('name restoration shares the pool exact audit receipts without accepting a changed or unregistered row', async () => {
  for (const variant of ['receipted', 'changed', 'unregistered']) {
    const f = fixture(), helper = await captureGeneratedWorkspaceName(f.scope)
    f.replaceWorkspace({ name: f.englishName })
    const audit = row({ id: 'retained-fixture-event', ownerId: OWNER, action: 'delete', source: 'source_deleted' })
    f.owner.set('resource_access_events', [audit])
    if (variant !== 'unregistered') f.retained.push({ table_name: 'resource_access_events', record_id: audit.value.id, fingerprint: createHash('sha256').update(audit.text).digest('hex') })
    if (variant === 'changed') f.owner.set('resource_access_events', [row({ ...audit.value, action: 'changed' })])
    if (variant === 'receipted') {
      assert.equal((await helper.restore({ drained: true })).phase, 'restored')
      assert.deepEqual(f.owner.get('resource_access_events'), [audit], 'immutable audit is retained in full')
    } else {
      await assert.rejects(helper.restore({ drained: true }), { code: 'WORKSPACE_NAME_CLEANUP_UNPROVEN' })
      assert.deepEqual(f.events, ['revoke'], 'an unproven footprint never reaches the restore RPC')
    }
  }
})

test('unchanged name needs no reauthentication or RPC and drain is mandatory', async () => {
  const f = fixture(), helper = await captureGeneratedWorkspaceName(f.scope)
  await assert.rejects(helper.restore(), { code: 'WORKSPACE_NAME_DRAIN_REQUIRED' })
  assert.deepEqual(f.events, [])
  const result = await helper.restore({ drained: true })
  assert.deepEqual(f.events, ['revoke'])
  assert.equal(result.phase, 'unchanged')
  assert.equal(result.restored, false)
  assert.equal(result.ownerMatchesSealedBaseline, true)
})

test('custom names, unrelated owner fields and peer changes all fail before reauthentication', async () => {
  for (const variant of ['custom', 'owner-field', 'peer']) {
    const f = fixture(), helper = await captureGeneratedWorkspaceName(f.scope)
    f.replaceWorkspace({ name: f.englishName })
    if (variant === 'custom') f.replaceWorkspace({ name: 'Unknown custom edit' })
    if (variant === 'owner-field') f.replaceWorkspace({ slug: 'unexpected' })
    if (variant === 'peer') f.peer.set('user', [row({ id: PEER, name: 'Unexpected peer edit' })])
    await assert.rejects(helper.restore({ drained: true }), { code: 'WORKSPACE_NAME_CLEANUP_UNPROVEN' })
    assert.deepEqual(f.events, ['revoke'])
    assert.equal(helper.read().restored, false)
  }
})

test('a rejected normal RPC or a new unrelated change cannot report successful cleanup', async () => {
  for (const variant of ['response', 'after']) {
    const f = fixture(), helper = await captureGeneratedWorkspaceName(f.scope)
    f.replaceWorkspace({ name: f.englishName })
    if (variant === 'response') f.failResponse()
    else f.changeAfterRestore()
    await assert.rejects(helper.restore({ drained: true }), { code: 'WORKSPACE_NAME_RESTORE_FAILED' })
    assert.notEqual(helper.read().phase, 'restored')
    assert.notEqual(helper.read().ownerMatchesSealedBaseline, true)
    // The surrounding original release remains able to revoke any newly
    // registered auth fixture even when restoration itself fails.
    await f.scope.pool.revokeSessions(f.scope.lease)
  }
})
