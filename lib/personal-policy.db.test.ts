import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { readFile } from 'node:fs/promises'
import { bindFixtureWorkspaceDatabase } from '../tests/helpers/workspace-database'

const databaseURL = process.env.E2E_DATABASE_URL
const disposable = disposableDatabase(process.env, databaseURL)
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('Share policy tests require an isolated local database')

test('historical PostgreSQL subscription grants never authorize cross-member use', { skip: !disposable }, async t => {
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `shared_policy_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const workspace = randomUUID(), otherWorkspace = randomUUID()
  let closeWorkspace: (() => Promise<void>) | undefined
  try {
    await pool.query(`CREATE TABLE workspace_subscription_shares ("ownerId" text,"workspaceId" uuid,"allowOthers" boolean NOT NULL,PRIMARY KEY ("ownerId","workspaceId"));
      CREATE TABLE workspace_personal_policies ("workspaceId" uuid PRIMARY KEY,subscriptions boolean NOT NULL);
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,kind text NOT NULL CHECK (kind IN ('personal','team')))`)
    await pool.query(await readFile(new URL('../drizzle/20261109035020_organization_governance.sql', import.meta.url), 'utf8'))
    await pool.query('INSERT INTO mikka_workspaces VALUES ($1,\'team\'),($2,\'team\')', [workspace, otherWorkspace])
    closeWorkspace = await bindFixtureWorkspaceDatabase(pool)
    const { othersMayUse, runMayUseCredentialSql } = await import('./personal-policy')
    let reads = 0
    const query = { query: ((sql: string, values?: unknown[]) => { reads++; return pool.query(sql, values) }) as Pool['query'] }
    const check = async (expected: boolean) => {
      reads = 0
      assert.equal(await othersMayUse(query, 'payor', workspace), expected)
      assert.equal(reads, 0)
    }
    for (const share of [undefined, false, true]) {
      for (const policy of [undefined, false, true]) {
        await t.test(`share=${String(share)}, policy=${String(policy)}`, async () => {
          await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
          if (share !== undefined) await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,$3)', ['payor', workspace, share])
          if (policy !== undefined) await pool.query('INSERT INTO workspace_personal_policies VALUES ($1,$2)', [workspace, policy])
          await check(false)
        })
      }
    }
    await t.test('the actual SQL gate accepts only the Owner, across authorized Workspaces', async () => {
      for (const tenant of [workspace, otherWorkspace]) {
        const sql = `SELECT ${runMayUseCredentialSql('$1', '$2', '$3')} AS allowed`
        assert.equal((await pool.query(sql, ['payor','borrower',tenant])).rows[0].allowed, false)
        assert.equal((await pool.query(sql, ['payor','payor',tenant])).rows[0].allowed, true)
      }
    })
    await t.test('foreign owner and foreign workspace shares cannot grant access', async () => {
      await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
      await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,true),($3,$4,true)', ['other', workspace, 'payor', otherWorkspace])
      await check(false)
    })
    await t.test('a different workspace policy cannot restore this subscription share', async () => {
      await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
      await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,true)', ['payor', workspace])
      await pool.query('INSERT INTO workspace_personal_policies VALUES ($1,false)', [otherWorkspace])
      await check(false)
    })
    await t.test('one executor observes each share or policy revocation and restoration', async () => {
      await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
      await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,true)', ['payor', workspace])
      await check(false)
      await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=false')
      await check(false)
      await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=true')
      await check(false)
      await pool.query('INSERT INTO workspace_personal_policies VALUES ($1,false)', [workspace])
      await check(false)
      await pool.query('DELETE FROM workspace_personal_policies')
      await check(false)
      await pool.query('DELETE FROM workspace_subscription_shares')
      await check(false)
    })
    await t.test('Organization approvals cannot restore old subscription borrowing', async () => {
      await pool.query('TRUNCATE workspace_subscription_shares,workspace_personal_policies')
      await pool.query('INSERT INTO workspace_subscription_shares VALUES ($1,$2,true)', ['payor', workspace])
      const organization = randomUUID(), decision = randomUUID()
      await pool.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES ($1,\'Fixture organization\',\'payor\')', [organization])
      await pool.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES ($1,$2)', [workspace, organization])
      await pool.query('INSERT INTO mikka_organization_resource_policies("organizationId","modelCredentialSharing") VALUES ($1,\'allow\')', [organization])
      await check(false)
      await pool.query('UPDATE mikka_organization_resource_policies SET "modelCredentialSharing"=\'deny\' WHERE "organizationId"=$1', [organization])
      await check(false)
      await pool.query('UPDATE mikka_organization_resource_policies SET "modelCredentialSharing"=\'approval_required\' WHERE "organizationId"=$1', [organization])
      await check(false)
      await pool.query('INSERT INTO mikka_organization_resource_approvals(id,"organizationId","workspaceId",kind,"resourceId","ownerId",status) VALUES ($1,$2,$3,\'subscription\',\'payor\',\'payor\',\'approved\')', [decision, organization, workspace])
      await check(false)
      await pool.query('UPDATE mikka_organization_resource_approvals SET status=\'denied\' WHERE id=$1', [decision])
      await check(false)
      await pool.query('UPDATE mikka_organization_resource_policies SET "modelCredentialSharing"=\'allow\' WHERE "organizationId"=$1', [organization])
      await check(false)
      await pool.query('DELETE FROM mikka_organization_resource_approvals WHERE id=$1', [decision])
      await check(false)
    })
  } finally {
    await closeWorkspace?.()
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
