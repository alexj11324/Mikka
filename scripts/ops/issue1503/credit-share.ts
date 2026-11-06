/** Authorized fixture configuration through the existing credit-share service.
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
import { encode, decode } from '../../../lib/desktop-rpc/wire'

const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const OWNER_PERSONAL = 'ed898131-d8ea-4734-8e83-9ee2cdfe9206'
const BOT_ID = '3d3ffb5c-bd4c-4a83-9f31-481d7815a78b'
const TASK_ID = 'caaaed63-8648-49b0-b17b-ff45c005876b'
const RUN_ID = '9f49787a-a5e4-437f-8432-c594c713a18e'
const ISSUE_ID = 'bf272b85-2430-4546-9038-8f3bc6998a5e'
const report: Record<string, any> = { version: 1, issue: 1503, phase: 'credit_share_setup', workspaceId: WORKSPACE_ID,
  ownerUserId: OWNER_ID, smokeUserId: SMOKE_ID, payerWorkspaceId: OWNER_PERSONAL,
  startedAt: new Date().toISOString(), status: 'running', changed: false }
const path = resolve(process.env.MIKKA_1503_CREDIT_SHARE_REPORT ?? 'issue1503-report/credit-share.json')
const checkpoint = async () => {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}
let stage = 'validate_fixture'
let session: Awaited<ReturnType<typeof smokeSession>> | undefined
try {
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
  stage = 'normal_smoke_retry'
  session = await smokeSession()
  const build = (await session.json('/api/version')).build
  if (!/^[a-f0-9]{40}$/.test(process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA ?? '') || build !== process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA)
    fail('credit_share_retry_deployment_changed')
  // One targeted read before the ordinary Retry button. The already succeeded
  // implementation and delivered completion event are never edited/replayed.
  const { rows: [paused] } = await pool.query(`SELECT b."workspaceId",t.stage,t.status,r.status AS run_status,
    t."candidateId" IS NULL AS candidate_missing,
    s."leaseHolder" IS NULL AND s."leaseUntil" IS NULL AS idle,
    strpos(COALESCE(s."lastError",''),'verification_required')>0 AS expected_error,
    date_trunc('milliseconds',s."lastErrorAt")=$7::timestamptz AS expected_error_time,
    e."deliveredAt" IS NOT NULL AS completion_delivered
    FROM bots b JOIN coordinator_sessions s ON s."botId"=b.id AND s."userId"=b."ownerId"
    JOIN factory_tasks t ON t.id=$3 AND t."botId"=b.id AND t."userId"=b."ownerId" AND t."issueId"=$5
    JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id AND a."runId"=$4
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=b."ownerId" AND r."issueId"=t."issueId"
    JOIN coordinator_events e ON e.id=$6 AND e."botId"=b.id AND e."userId"=b."ownerId" AND e."runId"=r.id AND e.kind='run_finished'
    WHERE b.id=$1 AND b."ownerId"=$2 AND b."archivedAt" IS NULL`, [BOT_ID, SMOKE_ID, TASK_ID, RUN_ID, ISSUE_ID,
    '0a614959-bb11-4f13-b70b-8298c6ee2c61', '2026-11-06T19:57:11.484Z'])
  if (!paused || paused.workspaceId !== WORKSPACE_ID || paused.stage !== 'execute' || paused.status !== 'running'
    || paused.run_status !== 'succeeded' || !paused.candidate_missing || !paused.idle || !paused.expected_error
    || !paused.expected_error_time || !paused.completion_delivered) fail('credit_share_retry_state_changed')
  const response = await session.request('/api/desktop/rpc', { ...session.post({ version: 1,
    action: 'coordinator.retryCoordinatorTurn', args: encode([BOT_ID]) }),
    headers: { 'content-type': 'application/json', cookie: `mikka-workspace=${WORKSPACE_ID}`, 'x-mikka-locale': 'en' } })
  const result = await response.json().catch(() => null)
  if (!response.ok || result?.ok !== true) fail('credit_share_retry_rpc_failed')
  const value = decode(result.result) as any
  const retried = value?.ok === true ? value.data : value
  if (value?.ok === false || retried?.queued !== true) fail('credit_share_retry_not_queued')
  report.retry = { requested: true, queued: true, botId: BOT_ID, taskId: TASK_ID, issueId: ISSUE_ID,
    succeededRunId: RUN_ID, source: 'normal_retry_coordinator_turn_rpc', build }
  // The existing live driver observes reconciliation. No business-data polling.
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
