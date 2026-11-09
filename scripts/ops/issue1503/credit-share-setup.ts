/** Setup-only authorized fixture configuration through the existing credit-share service.
 * Run with the server-only shim + tsx and the normal production workload env.
 * No verification, grant, reservation, payment or session rows are manufactured. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pool, withDatabaseClient } from '../../../lib/db'
import { workspacePool } from '../../../lib/workspace-db'
import { HostedUsageStore } from '../../../lib/abuse/store'
import { PaidResourceError } from '../../../lib/abuse/policy'
import { creditShareView, setOwnCreditShare, withSharedCredits } from '../../../lib/credit-shares'
import { OWNER_ID, SMOKE_ID, fail, smokeSession } from './http'
import { reentryRuntime } from './reentry-fixture.mjs'

const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const OWNER_PERSONAL = 'ed898131-d8ea-4734-8e83-9ee2cdfe9206'
const report: Record<string, any> = { version: 1, issue: 1503, phase: 'credit_share_setup', setupOnly: true, workspaceId: WORKSPACE_ID,
  ownerUserId: OWNER_ID, smokeUserId: SMOKE_ID, payerWorkspaceId: OWNER_PERSONAL,
  startedAt: new Date().toISOString(), status: 'running', changed: false }
const path = resolve(process.env.MIKKA_1503_CREDIT_SHARE_REPORT ?? 'issue1503-report/credit-share-setup.json')
const checkpoint = async () => {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}
let stage = 'validate_fixture'
let session: Awaited<ReturnType<typeof smokeSession>> | undefined
try {
  const runtime = reentryRuntime(process.env)
  report.operatorSha = runtime.operatorSha; report.marker = runtime.marker
  stage = 'normal_smoke_login'
  session = await smokeSession()
  report.productionBuild = (await session.json('/api/version')).build
  if (session.user.id !== SMOKE_ID || report.productionBuild !== runtime.expectedAppSha) fail('credit_share_setup_deployment_changed')
  stage = 'validate_fixture'
  const { rows: identities } = await pool.query(`SELECT id FROM "user" WHERE
    (id=$1 AND email=$2) OR (id=$3 AND email=$4)`, [OWNER_ID, 'alexjiang20232024@gmail.com', SMOKE_ID, 'alexjiang20232024+mikka-smoke-owner@gmail.com'])
  if (identities.length !== 2) fail('credit_share_identities_mismatch')
  const { rows: [fixture] } = await workspacePool.query(`SELECT w.id,w."userId",w.kind,w.slug,
    (SELECT count(*) FROM mikka_workspace_members m WHERE m."workspaceId"=w.id) AS members,
    (SELECT count(*) FROM mikka_workspace_members m WHERE m."workspaceId"=w.id AND m.status='active'
      AND m."userId"=ANY($2::text[])) AS expected_active,
    EXISTS(SELECT 1 FROM mikka_workspace_members m WHERE m."workspaceId"=w.id AND m."userId"=$3 AND m.status='active' AND m.role='admin') AS smoke_admin,
    EXISTS(SELECT 1 FROM mikka_workspaces p WHERE p.id=$4 AND p."userId"=$5 AND p.kind='personal') AS payer_owned
    FROM mikka_workspaces w WHERE w.id=$1`, [WORKSPACE_ID, [OWNER_ID, SMOKE_ID], SMOKE_ID, OWNER_PERSONAL, OWNER_ID])
  if (!fixture || fixture.userId !== SMOKE_ID || fixture.kind !== 'team' || fixture.slug !== 'issue-1503-factory-smoke-20261106'
    || Number(fixture.members) !== 2 || Number(fixture.expected_active) !== 2 || !fixture.smoke_admin || !fixture.payer_owned)
    fail('credit_share_fixture_mismatch')
  const usage = new HostedUsageStore(pool)
  stage = 'verify_real_payer_admission'
  const beforeAdmission = await usage.canUseMikkaPaid(OWNER_PERSONAL)
  if (!beforeAdmission.verified || beforeAdmission.free + beforeAdmission.purchased <= 0) fail('credit_share_owner_budget_missing')
  report.payerBefore = { verified: beforeAdmission.verified, positiveBudget: true }
  // Serializable absence read plus the normal ON CONFLICT service protects an
  // independently added share; this invocation only owns its own insertion.
  const client = await pool.connect()
  let commitAttempted = false
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await client.query("SET LOCAL statement_timeout='30s'")
    await withDatabaseClient(client, async () => {
      const before = await creditShareView(OWNER_ID, WORKSPACE_ID)
      if (before.mine || !before.canShare) fail('credit_share_original_changed')
      report.before = { mine: false, canShare: true }
      stage = 'enable_normal_owner_share'
      const after = await setOwnCreditShare(OWNER_ID, WORKSPACE_ID, true)
      const { rows: [row] } = await client.query(`SELECT "sharedAt"::text AS "sharedAt",
        xmin=pg_current_xact_id()::text::xid AS inserted_here
        FROM workspace_credit_shares WHERE "workspaceId"=$1 AND "userId"=$2`, [WORKSPACE_ID, OWNER_ID])
      if (!after.mine || !after.canShare || !row?.inserted_here || typeof row.sharedAt !== 'string') fail('credit_share_setup_conflict')
      stage = 'verify_real_shared_payer'
      const selected = await withSharedCredits(WORKSPACE_ID, async payer => ({ payer, admission: await usage.canUseMikkaPaid(payer) }))
      if (selected.payer !== OWNER_PERSONAL || !selected.admission.verified
        || selected.admission.free + selected.admission.purchased <= 0) fail('credit_share_payer_mismatch')
      report.after = { mine: true, canShare: true, sharedAt: row.sharedAt }
      report.sharedPayer = { workspaceId: selected.payer, ownerUserId: OWNER_ID, verified: true, positiveBudget: true }
      report.changed = true; report.status = 'prepared'
      // Safe exact restoration receipt exists before committing its setting.
      await checkpoint()
    })
    commitAttempted = true
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (!commitAttempted) report.changed = false
    else report.commitUnconfirmed = true
    throw error
  } finally { client.release() }
  stage = 'readback'
  const { rows: [saved] } = await pool.query('SELECT "sharedAt"::text AS "sharedAt" FROM workspace_credit_shares WHERE "workspaceId"=$1 AND "userId"=$2', [WORKSPACE_ID, OWNER_ID])
  if (saved?.sharedAt !== report.after.sharedAt || !(await creditShareView(OWNER_ID, WORKSPACE_ID)).mine) fail('credit_share_readback_changed')
  if ((await session.json('/api/version')).build !== runtime.expectedAppSha) fail('credit_share_setup_deployment_changed')
  stage = 'complete'
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.code = error instanceof Error && /^issue1503_[a-z0-9_]+$/.test(error.message) ? error.message
    : error instanceof PaidResourceError ? `paid_resource_${error.code}` : 'issue1503_credit_share_failed'
  process.exitCode = 1
} finally {
  report.stage = stage; report.completedAt = new Date().toISOString()
  await session?.close().catch(() => undefined)
  await Promise.allSettled([pool.end(), workspacePool.end()])
  await checkpoint()
  console.log(JSON.stringify(report))
}
