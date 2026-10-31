import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('credit billing history and remaining balance are workspace scoped', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { workspaceCreditBillingView } = await import('../lib/billing/history')
  const owner = await seedUser(pool, 'credit-owner')
  const member = await seedUser(pool, 'credit-member')
  const foreignOwner = await seedUser(pool, 'credit-foreign')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const foreign = await seedWorkspace(pool, foreignOwner, [{ userId: foreignOwner, role: 'admin' }])
  const legacy = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const workspaceIds = [workspace.id, foreign.id, legacy.id]
  t.after(async () => {
    for (const table of ['hosted_usage', 'hosted_allowances', 'hosted_verifications', 'hosted_legacy_workspaces', 'workspace_credit_grants', 'workspace_audit_events', 'mikka_workspace_members']) {
      await pool.query(`DELETE FROM ${table} WHERE "workspaceId"=ANY($1::uuid[])`, [workspaceIds])
    }
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, member, foreignOwner]])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const receiptUrl = 'https://pay.stripe.com/receipts/fixture'
  await pool.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",bucket,points,reason,"externalId","amountCents",currency,"stripeFeeCents","receiptUrl","createdAt") VALUES
    ($1,$2,'purchased',500,'purchase',$1::text,500,'usd',45,$3,'2026-10-02T00:00:00Z'),
    ($4,$2,'purchased',-100,'refund',$4::text,-100,'usd',NULL,$3,'2026-10-03T00:00:00Z'),
    ($5,$6,'purchased',9999,'purchase',$5::text,9999,'usd',NULL,NULL,'2026-10-04T00:00:00Z')`,
  [randomUUID(), workspace.id, receiptUrl, randomUUID(), randomUUID(), foreign.id])
  await pool.query('INSERT INTO hosted_verifications ("workspaceId","verifiedAt") VALUES ($1,\'2026-10-01T00:00:00Z\')', [workspace.id])
  await pool.query('INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,600000)', [workspace.id])
  await pool.query(`INSERT INTO hosted_usage (id,"workspaceId",model,state,"purchasedMicroUsd","reservedPurchased") VALUES
    ($1,$2,'fixture','settled',1250000,0),($3,$2,'fixture','pending',0,100000)`, [randomUUID(), workspace.id, randomUUID()])

  const view = await workspaceCreditBillingView(owner, workspace.id)
  assert.equal(view.balancePoints, 325, '60 gifted points plus 400 purchased minus 125 spent and 10 reserved')
  assert.deepEqual(view.transactions.map(({ type, points, amountCents, currency, stripeFeeCents, status, receiptUrl }) => ({ type, points, amountCents, currency, stripeFeeCents, status, receiptUrl })), [
    { type: 'refund', points: -100, amountCents: -100, currency: 'usd', stripeFeeCents: null, status: 'succeeded', receiptUrl },
    { type: 'topup', points: 500, amountCents: 500, currency: 'usd', stripeFeeCents: 45, status: 'succeeded', receiptUrl },
    { type: 'verification', points: 100, amountCents: 0, currency: 'usd', stripeFeeCents: null, status: 'succeeded', receiptUrl: null },
  ])
  assert.deepEqual(view.transactions.map(row => row.date), ['2026-10-03T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z'])
  await assert.rejects(workspaceCreditBillingView(member, workspace.id), /workspaceAccessDenied/)
  await assert.rejects(workspaceCreditBillingView(foreignOwner, workspace.id), /workspaceAccessDenied/)
  assert.deepEqual((await workspaceCreditBillingView(foreignOwner, foreign.id)).transactions.map(row => row.points), [9999])

  await pool.query('UPDATE hosted_allowances SET remaining=0 WHERE "workspaceId"=$1', [workspace.id])
  assert.equal((await workspaceCreditBillingView(owner, workspace.id)).transactions.at(-1)?.points, 100, 'spent gift retains its original transaction')
  await pool.query('INSERT INTO hosted_legacy_workspaces ("workspaceId") VALUES ($1)', [legacy.id])
  const grandfathered = await workspaceCreditBillingView(owner, legacy.id)
  assert.equal(grandfathered.balancePoints, 100)
  assert.deepEqual(grandfathered.transactions.map(row => row.type), ['verification'])
})
