import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createApprovedWrites } from './approved-writes'
import type { WriteProvider } from './write-contract'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs isolated PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('full migrations preserve personal approved writes and all deletion fences', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = 'operation_personal_guard_' + randomUUID().replaceAll('-', '') + '_e2e'
  let database: Pool | undefined
  let created = false
  try {
    await createTestDatabase(admin, name, 'template0')
    created = true
    const target = new URL(url!)
    target.pathname = '/' + name
    database = new Pool({ connectionString: target.toString(), max: 4 })
    const directory = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql'))))
      await database.query(await readFile(new URL(file, directory), 'utf8'))
    const db = database
    const owner = 'operation-personal-' + randomUUID(), sessionId = randomUUID()
    await db.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',
      [owner, 'Isolated personal operation', owner + '@example.invalid'])
    await db.query('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
      [sessionId, owner, randomUUID()])
    const actor = { userId: owner, sessionId }
    let executions = 0
    const provider: WriteProvider = {
      name: 'isolated-personal-operation',
      prepare: async () => ({ accountId: 'synthetic-account', version: 'synthetic-version', context: null }),
      execute: async input => {
        await input.beforeSend()
        executions++
        return { providerObjectId: 'synthetic-receipt', evidenceDigest: 'a'.repeat(64) }
      },
      lookup: async () => { throw Error('No recovery is needed for this successful isolated operation') },
    }
    const service = createApprovedWrites(db, provider, 'append_notion_paragraph', { actor })
    const proposed = await service.propose(owner, { page_id: randomUUID(), text: 'Offline provider fixture; no external write.' }, randomUUID())
    assert.equal(proposed.status, 'awaiting_approval')
    assert.equal((await service.decide(actor, proposed.actionId, true)).status, 'done')
    assert.equal(executions, 1, 'the actual service executes the offline provider once')
    assert.equal((await service.view(actor, proposed.actionId)).status, 'done')
    const original = (await db.query('SELECT * FROM operation_ledger WHERE "operationId"=$1', [proposed.actionId])).rows[0]
    assert.equal(original.workspaceId, 'personal:' + owner)
    assert.equal(original.ownerId, owner)
    assert.equal(original.status, 'succeeded')
    const guards = await db.query('SELECT tgname FROM pg_trigger WHERE tgrelid=\'operation_ledger\'::regclass AND NOT tgisinternal AND tgenabled=\'O\' ORDER BY tgname')
    assert.deepEqual(guards.rows.map(row => row.tgname), ['account_deletion_insert_guard', 'account_deletion_workspace_guard'])

    const insert = async (workspaceId: string) => {
      const id = randomUUID()
      const row = { ...original, operationId: id, intentKey: randomUUID(), idempotencyKey: createHash('sha256').update(id).digest('hex'), workspaceId }
      await db.query('INSERT INTO operation_ledger SELECT * FROM jsonb_populate_record(NULL::operation_ledger,$1)', [JSON.stringify(row)])
      return id
    }
    await t.test('an unrelated personal identity and arbitrary text remain rejected', async () => {
      await assert.rejects(insert('personal:another-owner'), { code: '22P02' })
      await assert.rejects(insert('not-a-workspace'), { code: '22P02' })
    })
    await t.test('a real UUID workspace still honors its deletion freeze on insert and update', async () => {
      const workspace = randomUUID(), frozen = randomUUID()
      const id = await insert(workspace)
      await db.query('INSERT INTO account_deletion_workspace_guards("workspaceId","jobId") VALUES($1,$2)', [frozen, randomUUID()])
      await assert.rejects(insert(frozen), { code: '55000', message: 'account_deletion_pending' })
      await db.query('INSERT INTO account_deletion_workspace_guards("workspaceId","jobId") VALUES($1,$2)', [workspace, randomUUID()])
      await assert.rejects(db.query('UPDATE operation_ledger SET "updatedAt"=clock_timestamp() WHERE "operationId"=$1', [id]),
        { code: '55000', message: 'account_deletion_pending' })
    })
    await t.test('a personal owner deletion freeze blocks both inserts and updates', async () => {
      await db.query('INSERT INTO account_deletion_guards("subjectId","jobId") VALUES($1,$2)', [owner, randomUUID()])
      await assert.rejects(insert('personal:' + owner), { code: '55000', message: 'account_deletion_pending' })
      await assert.rejects(db.query('UPDATE operation_ledger SET "updatedAt"=clock_timestamp() WHERE "operationId"=$1', [proposed.actionId]),
        { code: '55000', message: 'account_deletion_pending' })
      assert.equal((await db.query('SELECT count(*)::int AS n FROM operation_ledger WHERE "ownerId"=$1', [owner])).rows[0].n, 2)
      assert.equal(executions, 1, 'deletion rejection never retries an external action')
    })
  } finally {
    if (created) await dropTestDatabase(admin, name, database)
    else await database?.end()
    await admin.end()
  }
})
