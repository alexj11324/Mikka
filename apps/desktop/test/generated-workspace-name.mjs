import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { TestAccountPool } from '../../../scripts/test-accounts/pool.mjs'
import { retainedAuditFingerprints, retainedAuditMatches } from '../../../scripts/test-accounts/retained-resource-audit.mjs'

const importOptions = { parentURL: import.meta.url, tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) }

const fail = code => { throw Object.assign(new Error(code), { code }) }
const requireTrue = (value, code = 'WORKSPACE_NAME_CLEANUP_UNPROVEN') => { if (!value) fail(code) }
const hashOwned = (owned, receipts, replacement) => {
  const hash = createHash('sha256')
  for (const [table, rows] of [...owned].sort(([a], [b]) => a.localeCompare(b))) {
    const texts = rows.filter(row => !retainedAuditMatches(table, row, receipts))
      .map(row => replacement && table === 'mikka_workspaces' && row.value.id === replacement.id ? replacement.text : row.text).sort((a, b) => a.localeCompare(b))
    hash.update(JSON.stringify([table, texts]))
  }
  return hash.digest('hex')
}
const nameState = (name, expected) => ({ en: name === expected.en, zhCN: name === expected['zh-CN'] })

/**
 * The real UI localizes its owner's generated personal-workspace name. Preserve
 * that behavior, then restore only this exact fixture change through its normal
 * authenticated read after all native work has drained. No business SQL writes,
 * baseline changes, credential access, or ignored fingerprint fields.
 */
export async function captureGeneratedWorkspaceName(scope) {
  requireTrue(scope?.pool instanceof TestAccountPool, 'WORKSPACE_NAME_SCOPE_REQUIRED')
  const lease = { ...scope.lease }
  const owners = [scope.owner?.userId, scope.peer?.userId]
  requireTrue(owners.every(value => typeof value === 'string' && value) && owners[0] !== owners[1], 'WORKSPACE_NAME_SCOPE_REQUIRED')
  const { defaultWorkspaceName } = await tsImport('../../../lib/workspace-name.ts', importOptions)
  const { encode, decode } = await tsImport('../../../lib/desktop-rpc/wire.ts', importOptions)
  const evidence = { captured: false, phase: 'capture', restored: false }
  let original

  async function snapshot(projectName) {
    await scope.assertActive()
    requireTrue(scope.lease.id === lease.id && scope.lease.generation === lease.generation, 'WORKSPACE_NAME_SCOPE_REQUIRED')
    return scope.pool.transaction(async client => {
      await scope.pool.current(client, lease, { readOnly: true, requireUnexpired: true })
      const accounts = (await client.query('SELECT role,user_id,baseline FROM mikka_test_accounts.accounts WHERE pair_id=$1 ORDER BY role', [lease.pairId])).rows
      requireTrue(accounts.length === 2 && accounts[0].role === 'owner' && accounts[0].user_id === owners[0] && accounts[1].role === 'peer' && accounts[1].user_id === owners[1], 'WORKSPACE_NAME_SCOPE_REQUIRED')
      requireTrue(accounts.every(account => /^[a-f0-9]{64}$/.test(account.baseline)), 'WORKSPACE_NAME_SCOPE_REQUIRED')
      if (original) requireTrue(accounts[0].baseline === original.ownerBaseline && accounts[1].baseline === original.peerBaseline, 'WORKSPACE_NAME_SCOPE_REQUIRED')
      const owned = await Promise.all(owners.map(owner => scope.pool.ownedRows(client, owner)))
      // Apply the pool's exact, immutable cleanup receipts to every digest,
      // including the hypothetical name projection. Unregistered or modified
      // events still prevent restoration; no audit history is deleted.
      const receipts = await Promise.all(owners.map(owner => retainedAuditFingerprints(client, owner)))
      const users = (owned[0].get('user') ?? []).filter(row => row.value.id === owners[0])
      const personal = (owned[0].get('mikka_workspaces') ?? []).filter(row => row.value.userId === owners[0] && row.value.kind === 'personal')
      requireTrue(users.length === 1 && personal.length === 1, 'WORKSPACE_NAME_SCOPE_REQUIRED')
      const userName = users[0].value.name
      requireTrue(typeof userName === 'string' && typeof personal[0].value.name === 'string', 'WORKSPACE_NAME_SCOPE_REQUIRED')
      const workspace = personal[0].value
      let projected
      if (projectName !== undefined) {
        requireTrue(workspace.id === original.id, 'WORKSPACE_NAME_CLEANUP_UNPROVEN')
        const rows = (await client.query(
          'SELECT jsonb_set(to_jsonb(w), \'{name}\', to_jsonb($2::text), false)::text AS data FROM public.mikka_workspaces w WHERE id=$1 AND "userId"=$3 AND kind=\'personal\'',
          [original.id, projectName, owners[0]],
        )).rows
        requireTrue(rows.length === 1 && typeof rows[0].data === 'string')
        requireTrue(isDeepStrictEqual(JSON.parse(rows[0].data), { ...workspace, name: projectName }))
        projected = hashOwned(owned[0], receipts[0], { id: original.id, text: rows[0].data })
      }
      await scope.pool.current(client, lease, { readOnly: true, requireUnexpired: true })
      return { userName, workspace, ownerHash: hashOwned(owned[0], receipts[0]), peerHash: hashOwned(owned[1], receipts[1]), ownerBaseline: accounts[0].baseline, peerBaseline: accounts[1].baseline, projected }
    }, { readOnly: true })
  }

  const first = await snapshot()
  const expected = {
    en: defaultWorkspaceName('en', first.userName).slice(0, 120),
    'zh-CN': defaultWorkspaceName('zh-CN', first.userName).slice(0, 120),
  }
  original = { id: first.workspace.id, name: first.workspace.name, userName: first.userName, ownerBaseline: first.ownerBaseline, peerBaseline: first.peerBaseline }
  const locale = ['en', 'zh-CN'].find(value => original.name === expected[value])
  evidence.captured = true
  evidence.initialName = nameState(original.name, expected)
  evidence.initialOwnerMatchesSealedBaseline = first.ownerHash === first.ownerBaseline

  return {
    read() { return structuredClone(evidence) },
    async restore({ drained } = {}) {
      requireTrue(drained === true, 'WORKSPACE_NAME_DRAIN_REQUIRED')
      evidence.phase = 'original-auth-cleanup'
      // Exactly the same registered-session and login-audit cleanup as release.
      // This keeps the lease active and does not mark it clean or close its DB.
      await scope.assertActive()
      await scope.pool.revokeSessions(scope.lease)
      evidence.phase = 'preflight'
      const current = await snapshot(original.name)
      evidence.beforeName = nameState(current.workspace.name, expected)
      evidence.peerMatchesSealedBaseline = current.peerHash === current.peerBaseline
      requireTrue(evidence.peerMatchesSealedBaseline)
      if (current.ownerHash === current.ownerBaseline) {
        requireTrue(current.workspace.id === original.id && current.workspace.name === original.name && current.userName === original.userName)
        evidence.afterName = nameState(current.workspace.name, expected)
        evidence.ownerMatchesSealedBaseline = true
        evidence.phase = 'unchanged'
        return structuredClone(evidence)
      }
      requireTrue(locale && current.workspace.id === original.id && current.userName === original.userName)
      requireTrue(current.workspace.name !== original.name && Object.values(expected).includes(current.workspace.name))
      requireTrue(current.projected === current.ownerBaseline)
      evidence.onlyGeneratedNameDifference = true
      requireTrue(typeof scope.owner.reauthenticate === 'function', 'WORKSPACE_NAME_REAUTH_REQUIRED')
      evidence.phase = 'reauthenticate'
      await scope.owner.reauthenticate()
      evidence.phase = 'restore'
      const response = await scope.owner.request('/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1', 'x-mikka-locale': locale },
        body: JSON.stringify({ version: 1, action: 'workspace-settings.getWorkspaceGeneral', args: encode([original.id]) }),
      })
      const body = await response.json()
      requireTrue(response.status === 200 && body?.version === 1 && body?.ok === true, 'WORKSPACE_NAME_RESTORE_FAILED')
      const value = decode(body.result)
      requireTrue(value && !value.error && value.id === original.id && value.name === original.name && value.personal === true && value.canEdit === true, 'WORKSPACE_NAME_RESTORE_FAILED')
      evidence.restored = true
      evidence.phase = 'restored-auth-cleanup'
      await scope.pool.revokeSessions(scope.lease)
      evidence.phase = 'verify'
      const after = await snapshot()
      evidence.afterName = nameState(after.workspace.name, expected)
      evidence.ownerMatchesSealedBaseline = after.ownerHash === after.ownerBaseline
      evidence.peerMatchesSealedBaseline = after.peerHash === after.peerBaseline
      requireTrue(after.workspace.id === original.id && after.workspace.name === original.name && after.userName === original.userName && evidence.ownerMatchesSealedBaseline && evidence.peerMatchesSealedBaseline, 'WORKSPACE_NAME_RESTORE_FAILED')
      evidence.phase = 'restored'
      return structuredClone(evidence)
    },
  }
}
