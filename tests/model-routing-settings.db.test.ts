import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import type { OrderCandidate } from '../lib/model-order-plan'

if (dbUrl && !disposableDatabase(process.env, dbUrl)) throw Error('Model routing settings require isolated loopback *_e2e targets')

test('routing settings default on, preserve saved lists and isolate owner/workspace scope', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { readOrder, changeOrder, orderView } = await import('../lib/model-order')
  const ownerId = await seedUser(pool, 'routing-setting-owner'), otherId = await seedUser(pool, 'routing-setting-other')
  const first = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }, { userId: otherId, role: 'member' }])
  const second = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])
  const scope = { ownerId, workspaceId: first.id }
  const connectionId = randomUUID(), keyId = randomUUID()
  const source = { kind: 'subscription' as const, connectionId }
  const candidates: (OrderCandidate & { provider: string })[] = ['reported-opus', 'reported-light', 'reported-standard']
    .map(model => ({ harness: 'claude_code', model, name: model, source, provider: 'claude' }))
  candidates.push({ harness: 'claude_code', model: 'reported-other-key', name: 'reported-other-key', source: { kind: 'api_key', keyId }, provider: 'custom' })
  t.after(async () => {
    try {
      await pool.query('DELETE FROM model_order_entries WHERE "ownerId"=ANY($1)', [[ownerId, otherId]])
      await pool.query('DELETE FROM model_order_settings WHERE "ownerId"=ANY($1)', [[ownerId, otherId]])
      await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[first.id, second.id]])
      await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[first.id, second.id]])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[ownerId, otherId]])
    } finally { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) }
  })

  const initial = await readOrder(pool, scope, candidates)
  assert.equal(initial.autoModelRouting, true)
  assert.equal(initial.customized, false)
  assert.deepEqual(initial.entries.map(entry => entry.model), ['reported-opus', 'reported-light', 'reported-standard'])
  assert.ok(initial.entries.every(entry => entry.source.kind === 'subscription'), 'routing does not silently add a different paid credential')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_order_settings WHERE "ownerId"=$1', [ownerId])).rows[0].n, 0)
  assert.equal((await orderView(pool, { ownerId: otherId, workspaceId: first.id })).autoModelRouting, true)

  await changeOrder(pool, scope, { kind: 'autoRouting', enabled: false })
  const disabled = await readOrder(pool, scope, candidates)
  assert.equal(disabled.autoModelRouting, false)
  assert.equal(disabled.customized, false)
  assert.deepEqual(disabled.entries.map(entry => entry.model), ['reported-opus'])
  assert.equal((await readOrder(pool, { ownerId, workspaceId: second.id }, candidates)).autoModelRouting, true)
  assert.equal((await readOrder(pool, { ownerId: otherId, workspaceId: first.id }, candidates)).autoModelRouting, true)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_order_entries WHERE "ownerId"=$1', [ownerId])).rows[0].n, 0)
  await changeOrder(pool, scope, { kind: 'autoRouting', enabled: true })
  assert.deepEqual((await readOrder(pool, scope, candidates)).entries, initial.entries, 'default IDs and order survive the toggle')

  const catalogue = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']
    .map(model => ({ harness: 'claude_code' as const, model, name: model, source, provider: 'claude' }))
  assert.deepEqual((await readOrder(pool, scope, catalogue)).entries.map(entry => entry.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'])
  const futureCatalogue = [...catalogue, { ...catalogue[0], model: 'claude-opus-6', name: 'claude-opus-6' }]
  assert.deepEqual((await readOrder(pool, scope, futureCatalogue)).entries.map(entry => entry.model), ['claude-opus-6', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'])
  assert.equal(catalogue.length, 6, 'the complete manual catalogue is untouched')

  const entryId = randomUUID()
  await pool.query('UPDATE model_order_settings SET customized=true WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, first.id])
  await pool.query(`INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId")
    VALUES ($1,$2,$3,0,'claude_code','claude-opus-5','subscription',$4)`, [entryId, ownerId, first.id, connectionId])
  const customized = await readOrder(pool, scope, candidates)
  assert.deepEqual(customized.entries.map(entry => entry.model), ['claude-opus-5'])
  assert.deepEqual((await readOrder(pool, scope, futureCatalogue)).entries, customized.entries, 'a new release never rewrites a manual historical choice')
  await changeOrder(pool, scope, { kind: 'autoRouting', enabled: false })
  await changeOrder(pool, scope, { kind: 'location', location: 'local' })
  await changeOrder(pool, scope, { kind: 'autoRouting', enabled: true })
  const retained = await readOrder(pool, scope, candidates)
  assert.equal(retained.customized, true)
  assert.equal(retained.location, 'local')
  assert.deepEqual(retained.entries, customized.entries, 'toggle never rewrites or expands a customized list')
  await assert.rejects(changeOrder(pool, scope, { kind: 'autoRouting', enabled: 'false' as unknown as boolean }))
  assert.equal((await readOrder(pool, scope, candidates)).autoModelRouting, true)
})
