import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { e2bKeyAad, sealSecret, secretAad, userE2bKeyAad, userSecretAad } from './crypto'

test('map masking batches the same authorized material as the existing masker in PostgreSQL', { skip: !dbUrl }, async t => {
  const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
  const { Pool } = await import('pg')
  const connection = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool } = await import('../db'), { workspacePool } = await import('../workspace-db')
  const { maskFor } = await import('./runtime'), { maskProjectMapFacts } = await import('./project-map-mask')
  const { fingerprint } = await import('../project-map/cursor')
  const userIds: string[] = [], workspaceIds: string[] = []
  t.after(async () => {
    try {
      await connection.query('DELETE FROM workspace_secrets WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
      await connection.query('DELETE FROM workspace_e2b_keys WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
      await connection.query('DELETE FROM user_secrets WHERE "userId"=ANY($1::text[])', [userIds])
      await connection.query('DELETE FROM user_e2b_keys WHERE "userId"=ANY($1::text[])', [userIds])
      await connection.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
      await connection.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
      await connection.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [userIds])
    } finally { await Promise.all([connection.end(), pool.end(), workspacePool.end()]) }
  })
  for (const name of ['map-mask-owner', 'map-mask-peer', 'map-mask-removed', 'map-mask-foreign']) userIds.push(await seedUser(connection, name))
  const [ownerId, peerId, removedId, outsiderId] = userIds
  const home = await seedWorkspace(connection, ownerId, [{ userId: ownerId, role: 'admin' }, { userId: peerId, role: 'member' }, { userId: removedId, role: 'member', status: 'suspended' }])
  workspaceIds.push(home.id)
  const foreign = await seedWorkspace(connection, outsiderId, [{ userId: outsiderId, role: 'admin' }])
  workspaceIds.push(foreign.id)
  const values = Object.fromEntries(['workspace', 'repository', 'owner', 'duplicate', 'workspaceEnv', 'ownerEnv', 'peer', 'removed', 'outsider', 'legacy', 'foreignWorkspace', 'foreignOwner', 'foreignLegacy']
    .map(name => [name, `fixture-${name}-${randomUUID()}`]))
  const insertWorkspace = async (name: string, value: string, workspaceId = home.id, scopeType = 'workspace', kind = 'secret') => {
    const row = { id: randomUUID(), workspaceId, name, kind, scopeType, scopeRef: scopeType === 'repository' ? 'fixture/repo' : '' }
    const sealed = sealSecret(value, secretAad(row), env)
    await connection.query(`INSERT INTO workspace_secrets(id,"workspaceId",name,kind,"scopeType","scopeRef",ciphertext,iv,"keyVersion","createdBy","updatedBy")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [row.id, workspaceId, name, kind, scopeType, row.scopeRef, sealed.ciphertext, sealed.iv, sealed.keyVersion, ownerId])
    return { ...row, ...sealed }
  }
  const insertOwner = async (name: string, value: string, userId = ownerId, kind = 'secret') => {
    const row = { id: randomUUID(), userId, name, kind }, sealed = sealSecret(value, userSecretAad(row), env)
    await connection.query(`INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion") VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [row.id, userId, name, kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
    return { ...row, ...sealed }
  }
  const ordinary = await insertWorkspace('WORKSPACE', values.workspace)
  await insertWorkspace('REPOSITORY', values.repository, home.id, 'repository')
  await insertWorkspace('WORKSPACE_FIRST', values.duplicate)
  await insertWorkspace('VISIBLE_ENV', values.workspaceEnv, home.id, 'workspace', 'env')
  await insertWorkspace('FOREIGN_WORKSPACE', values.foreignWorkspace, foreign.id)
  const personal = await insertOwner('OWN', values.owner)
  const personalEnv = await insertOwner('OWN_ENV', values.ownerEnv, ownerId, 'env')
  await insertOwner('OWNER_DUPLICATE', values.duplicate)
  await insertOwner('FOREIGN_OWNER', values.foreignOwner, peerId)
  const keyValues = new Map([[ownerId, values.owner], [peerId, values.peer], [removedId, values.removed], [outsiderId, values.outsider]])
  for (const [userId, value] of keyValues) {
    const sealed = sealSecret(value, userE2bKeyAad(userId), env)
    await connection.query(`INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES($1,$2,$3,$4,'test')`, [userId, sealed.ciphertext, sealed.iv, sealed.keyVersion])
  }
  for (const [workspaceId, value] of [[home.id, values.legacy], [foreign.id, values.foreignLegacy]]) {
    const sealed = sealSecret(value, e2bKeyAad(workspaceId), env)
    await connection.query(`INSERT INTO workspace_e2b_keys("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") VALUES($1,$2,$3,$4,'test',$5,$5)`,
      [workspaceId, sealed.ciphertext, sealed.iv, sealed.keyVersion, outsiderId])
  }
  const target = { workspaceId: home.id, ownerId }
  const input = { [values.owner]: { items: Object.values(values), encoded: Buffer.from(values.repository).toString('base64'), token: 'ghp_abcdefghijklmnopqrstuvwx' } }
  const equalToLegacy = async () => {
    const expected = await maskFor(target, input, env), actual = await maskProjectMapFacts(target, input, env)
    assert.deepEqual(actual, expected)
    assert.equal(JSON.stringify(actual), JSON.stringify(expected))
    assert.equal(fingerprint(actual), fingerprint(expected))
    return actual
  }
  await t.test('workspace and every repository scope, owner-only secrets, active-member and legacy E2B keys keep the same masks and labels', async () => {
    const masked = await equalToLegacy()
    // E2B precedes owner secrets when the same value occurs in both sets.
    const result = masked['[secret:E2B_API_KEY]']
    assert.ok(result)
    assert.ok(result.items.includes('[secret:WORKSPACE]'))
    assert.ok(result.items.includes('[secret:REPOSITORY]'))
    assert.ok(result.items.includes('[secret:WORKSPACE_FIRST]'))
    for (const key of ['removed', 'outsider', 'foreignWorkspace', 'foreignOwner', 'foreignLegacy', 'workspaceEnv', 'ownerEnv']) assert.ok(result.items.includes(values[key]))
    assert.equal(result.encoded, '[secret:REPOSITORY]')
    assert.equal(result.token, '[secret:github-token]')
    const { rows: [legacyRow] } = await connection.query('SELECT "createdBy" FROM workspace_e2b_keys WHERE "workspaceId"=$1', [home.id])
    assert.equal(legacyRow.createdBy, outsiderId, 'masking must not adopt or rewrite legacy keys')
  })
  await t.test('a newly suspended member is excluded by the next masking request', async () => {
    await connection.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [home.id, peerId])
    const masked = await equalToLegacy()
    assert.ok(masked['[secret:E2B_API_KEY]'].items.includes(values.peer))
  })
  await t.test('corrupt required workspace, owner and owner-env rows fail closed using the real SQL projections', async () => {
    const log = t.mock.method(console, 'error', () => undefined)
    try {
      for (const [table, row] of [['workspace_secrets', ordinary], ['user_secrets', personal], ['user_secrets', personalEnv]] as const) {
        await connection.query(`UPDATE ${table} SET ciphertext='invalid' WHERE id=$1`, [row.id])
        try {
          for (const masker of [maskFor, maskProjectMapFacts]) await assert.rejects(masker(target, input, env), (error: unknown) =>
            error instanceof Error && (error as Error & { code?: string }).code === 'e2b_unavailable' && error.cause === undefined)
        } finally { await connection.query(`UPDATE ${table} SET ciphertext=$2 WHERE id=$1`, [row.id, row.ciphertext]) }
      }
      assert.ok(log.mock.calls.every(call => !JSON.stringify(call.arguments).includes('invalid')))
    } finally { log.mock.restore() }
  })
})
