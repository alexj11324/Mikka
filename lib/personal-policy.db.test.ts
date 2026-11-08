import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { othersMayUse } from './personal-policy'

const databaseURL = process.env.E2E_DATABASE_URL
const disposable = disposableDatabase(process.env, databaseURL)
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('Share policy tests require an isolated local database')

test('shared credential policy preserves scope and current revocation in one PostgreSQL read', { skip: !disposable }, async t => {
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `shared_policy_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const workspace = randomUUID(), otherWorkspace = randomUUID()
  try {
    await pool.query(`CREATE TABLE workspace_subscription_shares ("ownerId" text,"workspaceId" uuid,"allowOthers" boolean NOT NULL,PRIMARY KEY ("ownerId","workspaceId"));
      CREATE TABLE workspace_personal_policies ("workspaceId" uuid PRIMARY KEY,subscriptions boolean NOT NULL)`)
    let reads = 0
    const query = { query: ((sql: string, values?: unknown[]) => { reads++; return pool.query(sql, values) }) as Pool['query'] }
    const check = async (expected: boolean) => {
      reads = 0
      assert.equal(await othersMayUse(query, 'payor', workspace), expected)
      assert.equal(reads, 1)
    }
    for (const share of [undefined, false, true]) {
      for (const policy of [undefined, false, true]) {
        await t.test(`share=${String(share)}, policy=${String(policy)}`, async () => {
          await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
          if (share !== undefined) await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,$3)', ['payor', workspace, share])
          if (policy !== undefined) await pool.query('INSERT INTO workspace_personal_policies VALUES ($1,$2)', [workspace, policy])
          await check(share === true && policy !== false)
        })
      }
    }
    await t.test('foreign owner and foreign workspace shares cannot grant access', async () => {
      await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
      await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,true),($3,$4,true)', ['other', workspace, 'payor', otherWorkspace])
      await check(false)
    })
    await t.test('a different workspace policy does not revoke this share', async () => {
      await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
      await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,true)', ['payor', workspace])
      await pool.query('INSERT INTO workspace_personal_policies VALUES ($1,false)', [otherWorkspace])
      await check(true)
    })
    await t.test('one executor observes each share or policy revocation and restoration', async () => {
      await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
      await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,true)', ['payor', workspace])
      await check(true)
      await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=false')
      await check(false)
      await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=true')
      await check(true)
      await pool.query('INSERT INTO workspace_personal_policies VALUES ($1,false)', [workspace])
      await check(false)
      await pool.query('DELETE FROM workspace_personal_policies')
      await check(true)
      await pool.query('DELETE FROM workspace_subscription_shares')
      await check(false)
    })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
