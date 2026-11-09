/** Explicitly authorized #1503 fixture cleanup. Run only after the delivery receipt is saved. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pool, withDatabaseClient } from '../../../lib/db'
import { workspacePool } from '../../../lib/workspace-db'
import { setOwnSubscriptionShare } from '../../../lib/personal-policy-server'
import { creditShareView, setOwnCreditShare } from '../../../lib/credit-shares'
import { readOrder } from '../../../lib/model-order'
import { ownerSettingsChanged } from '../../../lib/live/lists'
import { computerGone, computerState, killComputer } from '../../../lib/computer/e2b-provider'
import { cleanupIssue1503SmokeGitHub, SmokeGitHubSetupError } from '../issue1503-smoke-github.mjs'
import { smokeSession, SMOKE_ID, OWNER_ID, fail } from './http'
import { modelOrderCleanupPlan, failedReleaseModelOrderCleanupPlan, f42606137512ModelOrderCleanupPlan, sameModelOrder } from './model-order-cleanup'
import { Sandbox } from 'e2b'
import { e2bApiKey } from '../../../lib/secrets/e2b-runtime'
import { threadLifecycleProvider } from '../../../lib/cloud-computer/thread-lifecycle-provider'
import { threadMachineProvider } from '../../../lib/cloud-computer/thread-machines'
import { loadAllocationScope, loadFailedAllocationScope, loadF42606137512AllocationScope, F42606137512_RELEASE_MODE, F42606137512_BINDING, allocationTargets, allocationIdentity, findLegacyCreated,
  confirmAllocationAbsence, assertAllocationPostcondition } from './cleanup-allocations.mjs'

const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const E2B_UPDATED_AT = '2026-11-06T18:21:51.895Z'
const ACTIVE_RUNS = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']
const HANDOFF_KEY = 'v2/github.com/alexj11324/mikka-handoff'
const cleanupMode = process.env.MIKKA_1503_CLEANUP_MODE ?? 'final_delivery'
const f42606137512Release = cleanupMode === F42606137512_RELEASE_MODE
const failedRelease = cleanupMode === 'failed_release' || f42606137512Release
const report: Record<string, any> = { issue: 1503, phase: failedRelease ? 'failed_release' : 'cleanup',
  ...(failedRelease ? { acceptancePassed: false, failedWorkflowRunId: f42606137512Release ? 42606137512 : 42535538611 } : {}), workspaceId: WORKSPACE_ID,
  startedAt: new Date().toISOString(), status: 'running', actions: [], retained: [] }
let session: Awaited<ReturnType<typeof smokeSession>> | undefined
let stage = 'fixture_state'
const completed = (task: { stage: string; status: string }) =>
  ['cancelled', 'revoked'].includes(task.status) || (task.stage === 'publish' && task.status === 'passed')
const safeCode = (error: unknown) => error instanceof Error && /^issue1503_[a-z0-9_]+$/.test(error.message)
  ? error.message : 'issue1503_cleanup_operation_failed'
function record(kind: string, fields: Record<string, unknown> = {}) { report.actions.push({ kind, ...fields }) }
async function attempt(kind: string, id: string, run: () => Promise<unknown>) {
  try { await run(); record(kind, { id }); return true }
  catch (error) { record(`${kind}_unconfirmed`, { id, code: safeCode(error) }); return false }
}

/** Restore only the exact share introduced by the authorized credit-share
 * setup. The normal service runs on the row-locked ambient transaction. */
async function restoreCreditShare(fixture: Record<string, any>) {
  const receipt = fixture.creditShareSetup ?? JSON.parse(await readFile(process.env.MIKKA_1503_CREDIT_SHARE_FILE
    ?? 'scripts/ops/issue1503/credit-share-state.json', 'utf8'))
  if (receipt.version !== 1 || receipt.issue !== 1503 || receipt.phase !== 'credit_share_setup'
    || receipt.workspaceId !== WORKSPACE_ID || receipt.ownerUserId !== OWNER_ID || receipt.smokeUserId !== SMOKE_ID
    || receipt.payerWorkspaceId !== 'ed898131-d8ea-4734-8e83-9ee2cdfe9206' || receipt.changed !== true
    || receipt.before?.mine !== false || receipt.after?.mine !== true || typeof receipt.after?.sharedAt !== 'string')
    fail('cleanup_credit_share_receipt_mismatch')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout='30s'")
    const { rows: [current] } = await client.query('SELECT "sharedAt"::text AS "sharedAt" FROM workspace_credit_shares WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE', [WORKSPACE_ID, OWNER_ID])
    if (current && current.sharedAt !== receipt.after.sharedAt) fail('cleanup_credit_share_concurrent_change')
    if (current) await withDatabaseClient(client, async () => {
      const after = await setOwnCreditShare(OWNER_ID, WORKSPACE_ID, false)
      if (after.mine) fail('cleanup_credit_share_restore_unconfirmed')
    })
    await client.query('COMMIT')
    if ((await creditShareView(OWNER_ID, WORKSPACE_ID)).mine) fail('cleanup_credit_share_readback_changed')
    report.creditShare = { mine: false, restored: true, alreadyAbsent: !current, originalSharedAt: receipt.after.sharedAt }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
  finally { client.release() }
}

/** Metadata only. Old blocked/passed tasks and retained sandbox IDs are not proof of live work. */
async function inventory() {
  const { rows: [row] } = await pool.query(`SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'userId',t."userId",'issueId',t."issueId",'stage',t.stage,'status',t.status))
      FROM factory_tasks t JOIN bots b ON b.id=t."botId" WHERE b."workspaceId"=$1), '[]') AS tasks,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'userId',r."userId",'status',r.status))
      FROM agent_runs r WHERE r.status=ANY($3::text[]) AND (
        EXISTS(SELECT 1 FROM bots b WHERE b.id=r."botId" AND b."workspaceId"=$1)
        OR EXISTS(SELECT 1 FROM thread_machines m WHERE m."runId"=r.id AND m."workspaceId"=$1)
        OR EXISTS(SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."workspaceId"=$1)
        OR EXISTS(SELECT 1 FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
          JOIN bots b ON b.id=t."botId" WHERE a."runId"=r.id AND b."workspaceId"=$1))), '[]') AS runs,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'runId',m."runId",'ownerId',m."ownerId",'workspaceId',m."workspaceId",'issueId',m."issueId",
      'operationId',m."operationId",'phase',m.lifecycle->>'phase','sandboxId',m."sandboxId",
      'state',m.state,'pending',(m."workerLeaseId" IS NOT NULL OR m."workerLeaseUntil" IS NOT NULL),
      'runOwnerId',r."userId",'runIssueId',r."issueId",'runStatus',r.status,'runFinishedAt',r."finishedAt",
      'runLeaseLive',COALESCE(r."leaseExpiresAt">now(),false),
      'legacyTerminalAtMatches',COALESCE(r."finishedAt"='2026-11-06T19:56:45.867476Z'::timestamptz,false)))
      FROM thread_machines m LEFT JOIN agent_runs r ON r.id=m."runId"
      WHERE m."workspaceId"=$1), '[]') AS threads,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('ownerId',"ownerId",'sandboxId',"sandboxId",'state',state,
      'pending',("provisionLeaseId" IS NOT NULL OR "provisionLeaseUntil" IS NOT NULL
        OR "workerLeaseId" IS NOT NULL OR "workerLeaseUntil" IS NOT NULL)))
      FROM cloud_machines WHERE "workspaceId"=$1), '[]') AS clouds,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'botId',"botId",'ownerId',"ownerId",'status',status))
      FROM bot_subagents WHERE "workspaceId"=$1 AND status IN ('queued','running','needs_you')), '[]') AS subagents,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('workspaceId',s."workspaceId",'sandboxId',s."sandboxId")) FROM (
      SELECT "workspaceId","sandboxId" FROM thread_machines WHERE "ownerId"=$2 AND "workspaceId"<>$1 AND "sandboxId" IS NOT NULL
      UNION SELECT "workspaceId","sandboxId" FROM cloud_machines WHERE "ownerId"=$2 AND "workspaceId"<>$1 AND "sandboxId" IS NOT NULL
    ) s), '[]') AS other_sandboxes,
    jsonb_build_object(
      'activeOrQueuedRuns', (SELECT count(*) FROM agent_runs WHERE "userId"=$2 AND status=ANY($3::text[])),
      'pendingFactoryWork', (SELECT count(*) FROM factory_tasks WHERE "userId"=$2 AND status IN ('pending','running')),
      'pendingThreadProvisioning', (SELECT count(*) FROM thread_machines WHERE "ownerId"=$2 AND "sandboxId" IS NULL
        AND (state='starting' OR "workerLeaseId" IS NOT NULL OR "workerLeaseUntil" IS NOT NULL)),
      'pendingCloudProvisioning', (SELECT count(*) FROM cloud_machines WHERE "ownerId"=$2
        AND (state='waking' OR "provisionLeaseId" IS NOT NULL OR "provisionLeaseUntil" IS NOT NULL)),
      'liveWorkerLeases', (SELECT count(*) FROM (
        SELECT 1 FROM thread_machines WHERE "ownerId"=$2 AND ("workerLeaseUntil">now() OR ("workerLeaseId" IS NOT NULL AND "workerLeaseUntil" IS NULL))
        UNION ALL SELECT 1 FROM cloud_machines WHERE "ownerId"=$2 AND ("workerLeaseUntil">now() OR ("workerLeaseId" IS NOT NULL AND "workerLeaseUntil" IS NULL))
      ) leases),
      'unfinishedSubagents', (SELECT count(*) FROM bot_subagents WHERE "ownerId"=$2 AND status IN ('queued','running','needs_you')),
      'pendingSandboxKills', (SELECT count(*) FROM sandbox_kill_retries WHERE "ownerId"=$2)
    ) AS global_activity,
    jsonb_build_object(
      'activeOrQueuedHandoffRuns', (SELECT count(*) FROM agent_runs r LEFT JOIN device_repos d ON d.id=r."deviceRepoId"
        WHERE r."userId"=$2 AND r.status=ANY($3::text[]) AND (lower(d."repoPath")=$4 OR lower(d."remoteUrl") IN (
          'https://github.com/alexj11324/mikka-handoff','https://github.com/alexj11324/mikka-handoff.git','git@github.com:alexj11324/mikka-handoff.git'))),
      'activeRunsWithUnknownRepository', (SELECT count(*) FROM agent_runs r LEFT JOIN device_repos d ON d.id=r."deviceRepoId"
        WHERE r."userId"=$2 AND r.status=ANY($3::text[]) AND d.id IS NULL),
      'pendingHandoffOrUnknownFactoryWork', (SELECT count(*) FROM factory_tasks t
        LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
        LEFT JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
        LEFT JOIN agent_runs r ON r.id=a."runId" LEFT JOIN device_repos d ON d.id=r."deviceRepoId"
        WHERE t."userId"=$2 AND t.status IN ('pending','running') AND (
          lower(d."repoPath")=$4 OR lower(d."remoteUrl") IN ('https://github.com/alexj11324/mikka-handoff',
            'https://github.com/alexj11324/mikka-handoff.git','git@github.com:alexj11324/mikka-handoff.git')
          OR lower(c.repository) IN ('alexj11324/mikka-handoff','https://github.com/alexj11324/mikka-handoff',
            'https://github.com/alexj11324/mikka-handoff.git','git@github.com:alexj11324/mikka-handoff.git')
          OR (d.id IS NULL AND c.id IS NULL))),
      'pendingHandoffPublications', (SELECT count(*) FROM run_publications p WHERE p."userId"=$2 AND lower(p."remoteKey")=$4
        AND (p.status IN ('pending','processing') OR p."leaseExpiresAt">now())),
      'pendingHandoffMerges', (SELECT count(*) FROM factory_merges m JOIN factory_candidates c ON c.id=m."candidateId" AND c."taskId"=m."taskId"
        WHERE m."userId"=$2 AND m.status='merging' AND lower(c.repository) IN ('alexj11324/mikka-handoff',
          'https://github.com/alexj11324/mikka-handoff','https://github.com/alexj11324/mikka-handoff.git','git@github.com:alexj11324/mikka-handoff.git'))
    ) AS github_activity`, [WORKSPACE_ID, SMOKE_ID, ACTIVE_RUNS, HANDOFF_KEY])
  return row as { tasks: any[]; runs: any[]; threads: any[]; clouds: any[]; subagents: any[];
    other_sandboxes: { workspaceId: string; sandboxId: string }[];
    global_activity: Record<string, number>; github_activity: Record<string, number> }
}
function counts(state: Awaited<ReturnType<typeof inventory>>) {
  return { tasks: state.tasks.length, unfinishedTasks: state.tasks.filter(task => !completed(task)).length,
    activeRuns: state.runs.length, threadMachines: state.threads.length, cloudMachines: state.clouds.length,
    activeSubagents: state.subagents.length, otherRecordedSandboxes: state.other_sandboxes.length,
    globalActivity: state.global_activity, githubActivity: state.github_activity }
}
async function providerAbsent(sandboxId: string, workspaceId = WORKSPACE_ID) {
  try { await computerState(workspaceId, sandboxId); return false }
  catch (error) { if (computerGone(error)) return true; throw error }
}
async function scopedRequest(path: string, init: RequestInit = {}) {
  if (!session) fail('cleanup_session_missing')
  return session.request(path, { ...init, headers: { ...init.headers,
    cookie: `mikka-workspace=${WORKSPACE_ID}`, 'x-mikka-locale': 'en' } })
}
async function scopedJson(path: string, init?: RequestInit) {
  const response = await scopedRequest(path, init)
  if (!response.ok) fail(`cleanup_http_${response.status}`)
  return response.json()
}

const unwrap = (value: any) => value?.ok === true ? value.data : value

/** Operator-only repair of this fixture's first driver's materialized default. The normal API has no reset action. */
async function restoreModelOrderDefault(failureReports?: any[]) {
  const initial = JSON.parse(await readFile(process.env.MIKKA_1503_INITIAL_ORDER_FILE
    ?? 'scripts/ops/issue1503/initial-model-order.json', 'utf8'))
  const latest = failureReports ? failureReports[1] : JSON.parse(await readFile(process.env.MIKKA_1503_SUCCESSFUL_DELIVERY_FILE
    ?? 'scripts/ops/issue1503/last-successful-delivery.json', 'utf8'))
  const { original, materialized, currentDefault } = failureReports
    ? (f42606137512Release ? f42606137512ModelOrderCleanupPlan(initial, failureReports)
      : failedReleaseModelOrderCleanupPlan(initial, failureReports)) : modelOrderCleanupPlan(initial, latest)
  const currentView = unwrap(await session!.rpc('model-order.getModelOrder', [WORKSPACE_ID]))
  if (currentView.customized === false) {
    if (!sameModelOrder(currentView, currentDefault)) fail('cleanup_model_order_default_changed')
    report.modelOrder = { status: 'already_default', customized: false, defaultEntries: currentDefault.entries.length }
    return
  }
  if (currentView.customized !== true || !sameModelOrder(currentView, materialized))
    fail('cleanup_model_order_concurrent_change')
  const scope = { ownerId: SMOKE_ID, workspaceId: WORKSPACE_ID }
  const client = await pool.connect()
  let removedEntries = 0
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '3s'")
    await client.query("SET LOCAL statement_timeout = '20s'")
    // Same serialization boundary as every normal changeOrder operation.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`model-order:${SMOKE_ID}:${WORKSPACE_ID}`])
    const { rows: [settings] } = await client.query(`SELECT location,customized,"preferredHarness","autoModelRouting",
      "updatedAt"::text AS updated_at FROM model_order_settings WHERE "ownerId"=$1 AND "workspaceId"=$2 FOR UPDATE`, [SMOKE_ID, WORKSPACE_ID])
    const entries = (await client.query(`SELECT id,"createdAt"::text AS created_at FROM model_order_entries
      WHERE "ownerId"=$1 AND "workspaceId"=$2 ORDER BY position,id FOR UPDATE`, [SMOKE_ID, WORKSPACE_ID])).rows
    const withinDriver = (value: string) => Date.parse(value) >= Date.parse(latest.startedAt) && Date.parse(value) <= Date.parse(latest.completedAt)
    const locked = await readOrder(client, scope)
    if (!settings?.customized || !withinDriver(settings.updated_at) || entries.some(entry => !withinDriver(entry.created_at))
      || !sameModelOrder(locked, materialized) || entries.length !== materialized.entries.length)
      fail('cleanup_model_order_writer_guard_changed')
    const changed = await client.query(`UPDATE model_order_settings SET customized=false,"updatedAt"=clock_timestamp()
      WHERE "ownerId"=$1 AND "workspaceId"=$2 AND customized=true AND "updatedAt"=$3::timestamptz
        AND location=$4 AND "preferredHarness"=$5 AND "autoModelRouting"=$6 RETURNING "ownerId"`,
    [SMOKE_ID, WORKSPACE_ID, settings.updated_at, original.location, original.preferredHarness, original.autoModelRouting])
    if (changed.rowCount !== 1) fail('cleanup_model_order_compare_failed')
    // The tentative flag is invisible to other transactions. Reuse the real default resolver, and roll back if the catalogue changed.
    const resolvedDefault = await readOrder(client, scope)
    if (!sameModelOrder(resolvedDefault, currentDefault))
      fail('cleanup_model_order_default_changed')
    const removed = await client.query(`DELETE FROM model_order_entries WHERE "ownerId"=$1 AND "workspaceId"=$2
      AND id=ANY($3::uuid[]) RETURNING id`, [SMOKE_ID, WORKSPACE_ID, entries.map(entry => entry.id)])
    const { rows: [remaining] } = await client.query('SELECT count(*) AS n FROM model_order_entries WHERE "ownerId"=$1 AND "workspaceId"=$2', [SMOKE_ID, WORKSPACE_ID])
    if (removed.rowCount !== entries.length || Number(remaining.n) !== 0) fail('cleanup_model_order_entries_changed')
    removedEntries = removed.rowCount ?? 0
    await ownerSettingsChanged(client, SMOKE_ID)
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
  finally { client.release() }
  const restored = unwrap(await session!.rpc('model-order.getModelOrder', [WORKSPACE_ID]))
  if (!sameModelOrder(restored, currentDefault)) fail('cleanup_model_order_readback_changed')
  report.modelOrder = { status: 'default_restored', customized: false, removedEntries,
    initialEntries: original.entries.length, defaultEntries: currentDefault.entries.length, guardedByDriverWindow: true }
}

try {
  if (!['final_delivery', 'failed_release', F42606137512_RELEASE_MODE].includes(cleanupMode)) fail('cleanup_mode_invalid')
  const fixtureBytes = await readFile(process.env.MIKKA_1503_FIXTURE_STATE_FILE ?? 'scripts/ops/issue1503/fixture-state.json')
  if (f42606137512Release && createHash('sha256').update(fixtureBytes).digest('hex') !== F42606137512_BINDING.fixtureSha256)
    fail('cleanup_f42606137512_fixture_sha_mismatch')
  const state = JSON.parse(fixtureBytes.toString('utf8'))
  if (state.issue !== 1503 || state.workspaceId !== WORKSPACE_ID || state.ownerUserId !== OWNER_ID || state.smokeUserId !== SMOKE_ID
    || state.shareBefore?.shared !== false || state.shareBefore?.allowOthers !== false
    || state.e2bChanged !== true || state.e2bSetup?.userId !== SMOKE_ID || state.e2bSetup?.updatedAt !== E2B_UPDATED_AT
    || state.githubSetup?.userId !== SMOKE_ID || state.githubSetup?.ownerUserId !== OWNER_ID
    || state.githubSetup?.repository !== 'alexj11324/Mikka-handoff') fail('cleanup_fixture_state_mismatch')

  stage = 'allocation_inputs'
  const allocationConfig = JSON.parse(await readFile(process.env.MIKKA_1503_ALLOCATION_SCOPE_FILE
    ?? 'scripts/ops/issue1503/cleanup-allocation-scope.json', 'utf8'))
  const allocationScope = f42606137512Release
    ? await loadF42606137512AllocationScope(allocationConfig, process.env.MIKKA_1503_FAILED_DELIVERY_FILE
      ?? 'scripts/ops/issue1503/last-failed-delivery.json')
    : failedRelease
    ? await loadFailedAllocationScope(allocationConfig, process.env.MIKKA_1503_FAILED_DELIVERY_FILE
      ?? 'scripts/ops/issue1503/last-failed-delivery.json')
    : await loadAllocationScope(allocationConfig, process.env.MIKKA_1503_SUCCESSFUL_DELIVERY_FILE
      ?? 'scripts/ops/issue1503/last-successful-delivery.json')
  report.allocationScope = { receipts: allocationScope.receipts,
    ...(failedRelease ? { mode: 'failed_release', acceptancePassed: false,
      latestFailedRawSha256: allocationScope.latestFailedRawSha256 }
      : { latestSuccessfulRawSha256: allocationScope.latestSuccessfulRawSha256 }) }
  stage = 'fixture_scope'
  const { rows: [workspace] } = await workspacePool.query(`SELECT w.id,w."userId",w.kind,w.slug,
    (SELECT count(*) FROM mikka_workspace_members m WHERE m."workspaceId"=w.id
      AND (m."userId"<>ALL($2::text[]) OR m.status<>'active')) AS unexpected,
    EXISTS(SELECT 1 FROM mikka_workspace_members m WHERE m."workspaceId"=w.id AND m."userId"=$3
      AND m.status='active' AND m.role='admin') AS smoke_admin
    FROM mikka_workspaces w WHERE w.id=$1`, [WORKSPACE_ID, [SMOKE_ID, OWNER_ID], SMOKE_ID])
  if (!workspace || workspace.userId !== SMOKE_ID || workspace.kind !== 'team'
    || workspace.slug !== 'issue-1503-factory-smoke-20261106' || Number(workspace.unexpected) !== 0 || !workspace.smoke_admin)
    fail('cleanup_workspace_scope_changed')
  session = await smokeSession()
  report.productionBuild = (await session.json('/api/version')).build
  let current = await inventory()
  report.before = counts(current)
  // Freeze new-case operation IDs from this existing inventory. Historical IDs are already pinned.
  allocationScope.allocations = allocationIdentity(allocationTargets(allocationScope, current))

  stage = 'stop_fixture_work'
  for (const task of current.tasks.filter(item => item.userId === SMOKE_ID && !completed(item))) {
    await attempt('factory_task_cancelled', task.id, async () => {
      const value = await scopedJson(`/api/factory/tasks/${task.id}`)
      if (value.task?.id !== task.id) fail('cleanup_factory_binding_changed')
      if (completed(value.task)) return
      await scopedJson(`/api/factory/tasks/${task.id}`, session!.post({ binding: { taskId: task.id, revision: value.task.revision },
        eventId: randomUUID(), action: 'cancel', reason: failedRelease ? 'Issue #1503 production window ended after failed acceptance; release only this fixture’s unfinished resources.' : 'Issue #1503 production verification finished; release only this fixture’s unfinished resources.' }))
    })
  }
  for (const subagent of current.subagents.filter(item => item.ownerId === SMOKE_ID)) {
    await attempt('subagent_stopped', subagent.id, async () => {
      await scopedJson(`/api/bots/${subagent.botId}/subagents/${subagent.id}/stop`, session!.post({}))
    })
  }
  for (const run of current.runs.filter(item => item.userId === SMOKE_ID)) {
    await attempt('thread_stopped', run.id, async () => {
      const response = await scopedRequest(`/api/mobile/threads/${run.id}/stop`, session!.post({}))
      const value = await response.json().catch(() => null)
      if (!response.ok && !(response.status === 409 && value?.error === 'runChainEnded')) fail('cleanup_run_stop_unconfirmed')
    })
  }

  stage = 'end_fixture_machines'
  // Re-read once after cancellation: a stage that was provisioning may now have a machine row.
  current = await inventory()
  allocationTargets(allocationScope, current)
  const endedSandboxes = new Set<string>()
  for (const machine of current.threads.filter(item => item.ownerId === SMOKE_ID)) {
    if (machine.state === 'ended' && !machine.sandboxId && !machine.pending) continue
    await attempt('thread_machine_ended', machine.runId, async () => {
      let acknowledged = false
      try {
        const response = await scopedRequest(`/api/threads/${machine.runId}/machine`, session!.post({ action: 'end' }))
        const value = await response.json().catch(() => null)
        acknowledged = response.ok && value?.runId === machine.runId && value.state === 'ended'
      } catch { /* A lost response is resolved only by the fresh row and provider observation below. */ }
      if (machine.sandboxId) {
        if (!await providerAbsent(machine.sandboxId)) fail('cleanup_thread_sandbox_present')
        endedSandboxes.add(machine.sandboxId)
      } else if (!acknowledged) fail('cleanup_thread_end_unconfirmed')
    })
  }
  current = await inventory()
  allocationTargets(allocationScope, current)
  const unfinished = current.runs.length || current.subagents.length || current.tasks.some(task => !completed(task))
  for (const machine of current.clouds.filter(item => item.ownerId === SMOKE_ID && item.sandboxId)) {
    await attempt('cloud_machine_ended', SMOKE_ID, async () => {
      if (unfinished || machine.pending) fail('cleanup_cloud_work_pending')
      // Existing owner-resolving application service; no direct machine-table writes or workspace deletion.
      try { await killComputer(WORKSPACE_ID, machine.sandboxId) }
      catch (error) { if (!computerGone(error)) throw error }
      if (!await providerAbsent(machine.sandboxId)) fail('cleanup_cloud_sandbox_present')
      endedSandboxes.add(machine.sandboxId)
    })
  }

  stage = 'verify_exact_allocation_absence'
  report.providerAllocations = { status: 'pending', receipts: [] }
  const allocationBefore = await confirmAllocationAbsence(allocationScope, current, {
    modern: threadLifecycleProvider.findCreated,
    legacy: (target: any) => findLegacyCreated(target, {
      list: (options: any) => Sandbox.list(options),
      options: async (ownerId: string) => ({ apiKey: await e2bApiKey(ownerId, 'Cloud runtime unavailable'),
        proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy, requestTimeoutMs: 15_000 }),
    }),
    kill: threadMachineProvider.kill,
    info: threadLifecycleProvider.info,
  }, endedSandboxes, (receipt: any) => report.providerAllocations.receipts.push(receipt))

  stage = 'verify_resource_boundary'
  current = await inventory()
  assertAllocationPostcondition(allocationScope, current, allocationBefore, endedSandboxes)
  report.providerAllocations.status = 'confirmed'
  report.after = counts(current)
  const pendingThreads = current.threads.filter(machine => machine.state !== 'ended' || machine.pending
    || (machine.sandboxId && !endedSandboxes.has(machine.sandboxId)))
  const pendingClouds = current.clouds.filter(machine => machine.pending
    || (machine.sandboxId ? !endedSandboxes.has(machine.sandboxId) : ['waking', 'running'].includes(machine.state)))
  report.resources = { confirmedAbsentSandboxes: endedSandboxes.size, pendingThreads: pendingThreads.length, pendingClouds: pendingClouds.length }
  const fixturePending = current.runs.length || current.subagents.length || current.tasks.some(task => !completed(task))
    || pendingThreads.length || pendingClouds.length
  if (fixturePending) {
    // Leave the runtime's settings and shares available until every fixture
    // task and machine has stopped. A failed end call must remain retryable.
    report.retained.push({ kind: 'fixture_settings_and_shares', reason: 'fixture_resources_unconfirmed' })
    report.retained.push({ kind: 'github_and_e2b_credentials', reason: 'fixture_resources_unconfirmed', globalActivity: current.global_activity })
    record('fixture_resource_cleanup_retry_required', { workspaceId: WORKSPACE_ID })
    report.status = 'incomplete'
    process.exitCode = 1
  } else {
    stage = 'restore_fixture_model_order_default'
    try {
      await restoreModelOrderDefault(failedRelease ? allocationScope.sourceReports : undefined)
    } catch (error) {
      report.modelOrder = { status: 'retained', code: safeCode(error) }
      report.retained.push({ kind: 'model_order', reason: 'conditional_restore_not_confirmed' })
      report.status = 'incomplete'
      process.exitCode = 1
    }

    stage = 'restore_owner_credit_share'
    try {
      await restoreCreditShare(state)
    } catch (error) {
      report.creditShare = { status: 'retained', code: safeCode(error) }
      report.retained.push({ kind: 'credit_share', reason: 'conditional_restore_not_confirmed' })
      report.status = 'incomplete'; process.exitCode = 1
    }

    stage = 'restore_owner_subscription_share'
    // Same owner-authorized business service used by preflight; scope is exactly this workspace.
    const share = await setOwnSubscriptionShare(OWNER_ID, WORKSPACE_ID, { shared: false, allowOthers: false })
    if (share.shared || share.allowOthers) fail('cleanup_share_restore_unconfirmed')
    report.subscriptionShare = { shared: share.shared, allowOthers: share.allowOthers }

    stage = 'revoke_exact_smoke_github_token'
    if (Object.values(current.github_activity).some(value => Number(value) > 0)) {
      report.retained.push({ kind: 'github_token', reason: 'handoff_or_unknown_repository_work_pending', activity: current.github_activity })
    } else {
      try {
        report.github = await cleanupIssue1503SmokeGitHub(state.githubSetup)
        if (!report.github.revoked || !report.github.disconnected) fail('cleanup_github_incomplete')
      } catch (error) {
        report.github = { status: 'unconfirmed', code: safeCode(error),
          ...(error instanceof SmokeGitHubSetupError ? { failure: error.toJSON() } : {}) }
        report.status = 'incomplete'
        process.exitCode = 1
      }
    }

    stage = 'remove_exact_smoke_e2b_key'
    // Normal deletion also removes this person's legacy workspace keys. Preserve unrelated legacy credentials.
    const keyMetadata = async () => (await pool.query(`SELECT
      (SELECT "updatedAt" FROM user_e2b_keys WHERE "userId"=$1) AS updated_at,
      (SELECT count(*) FROM workspace_e2b_keys WHERE "createdBy"=$1) AS legacy_count`, [SMOKE_ID])).rows[0]
    const key = await keyMetadata()
    if (Object.values(current.global_activity).some(value => Number(value) > 0)) {
      report.retained.push({ kind: 'e2b_key', reason: 'live_work_or_pending_operation', activity: current.global_activity })
    } else if (Number(key.legacy_count) !== 0 || (key.updated_at && new Date(key.updated_at).toISOString() !== E2B_UPDATED_AT)) {
      report.retained.push({ kind: 'e2b_key', reason: Number(key.legacy_count) ? 'unrelated_legacy_keys' : 'key_replaced_since_setup' })
    } else if (!key.updated_at) {
      report.e2b = { status: 'already_absent' }
    } else {
      // Historical IDs do not establish a live sandbox. Only GET info is used outside this fixture; never wake, pause, kill or rewrite those rows.
      const observations = { recorded: current.other_sandboxes.length, absent: 0, present: 0, unknown: 0, readOnly: true }
      for (const machine of current.other_sandboxes) {
        try { if (await providerAbsent(machine.sandboxId, machine.workspaceId)) observations.absent++; else observations.present++ }
        catch { observations.unknown++ }
      }
      report.otherSandboxObservations = observations
      if (observations.present || observations.unknown) {
        report.retained.push({ kind: 'e2b_key', reason: observations.present ? 'unrelated_sandbox_still_exists' : 'unrelated_sandbox_state_unconfirmed' })
      } else {
        // Re-check operations and the exact sandbox set after provider reads; the normal delete API has no timestamp CAS parameter.
        const latest = await inventory()
        assertAllocationPostcondition(allocationScope, latest, allocationBefore, endedSandboxes)
        const observed = new Set(current.other_sandboxes.map(machine => `${machine.workspaceId}:${machine.sandboxId}`))
        const newSandbox = latest.other_sandboxes.some(machine => !observed.has(`${machine.workspaceId}:${machine.sandboxId}`))
          || [...latest.threads, ...latest.clouds].some(machine => machine.sandboxId && !endedSandboxes.has(machine.sandboxId))
        const finalKey = await keyMetadata()
        if (newSandbox || Object.values(latest.global_activity).some(value => Number(value) > 0)) {
          report.retained.push({ kind: 'e2b_key', reason: 'activity_started_during_cleanup', activity: latest.global_activity })
        } else if (Number(finalKey.legacy_count) !== 0 || (finalKey.updated_at && new Date(finalKey.updated_at).toISOString() !== E2B_UPDATED_AT)) {
          report.retained.push({ kind: 'e2b_key', reason: 'key_changed_during_cleanup' })
        } else if (!finalKey.updated_at) {
          report.e2b = { status: 'already_absent' }
        } else {
          const result = await session.rpc('workspace-secrets.deleteE2BKey', [WORKSPACE_ID])
          const data = unwrap(result)
          if (data?.removed !== true) fail('cleanup_e2b_delete_unconfirmed')
          const remaining = await pool.query('SELECT count(*) AS n FROM user_e2b_keys WHERE "userId"=$1', [SMOKE_ID])
          if (Number(remaining.rows[0].n) !== 0) fail('cleanup_e2b_readback_unconfirmed')
          report.e2b = { status: 'removed', setupUpdatedAt: E2B_UPDATED_AT }
        }
      }
    }
    if (report.status === 'running') report.status = report.retained.length ? 'completed_with_retained_credentials' : 'completed'
  }
} catch (error) {
  report.status = 'incomplete'
  report.code = safeCode(error)
  const causeCode = (error as any)?.code ?? (error as any)?.cause?.code
  if (typeof causeCode === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(causeCode)) report.causeCode = causeCode
  process.exitCode = 1
} finally {
  report.stage = stage
  if (session) await session.close().catch(() => undefined)
  await Promise.allSettled([pool.end(), workspacePool.end()])
  report.completedAt = new Date().toISOString()
  await mkdir('issue1503-report', { recursive: true })
  await writeFile('issue1503-report/cleanup.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report))
}
