import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Historical cad fixture only. This operator never creates a login/session.
export const FIXTURE = Object.freeze({
  ownerId: 'OFtPbAHifGBAOYiek9hd3w', workspaceId: 'de300001-ece6-4021-8214-c986ea306bde',
  botId: 'bc925088-d87f-47b8-a786-c1c317ac005f', issueId: '43486283-4731-4842-bce1-fa5f1e96b8f9',
  deviceId: '09479c68-dcb4-4735-a91f-e355259c0eef', agentId: '09abf8d5-95c0-4444-9018-8f2b0772b458',
  rootRunId: 'f879d6cd-bdbd-4e62-9a17-441f1f763a25', childRunId: '5b15edaf-e179-439b-b580-ffc625384621',
  failedSource: 'cad613ef0a2c553a94aaf72d44d609c93a603a1b', failedWorkflowRunId: '42336625140',
})
const RUN_IDS = [FIXTURE.rootRunId, FIXTURE.childRunId]
const LIVE = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']
const TERMINAL = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{64}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const iso = value => value instanceof Date ? value.toISOString() : value
const fail = (code, cause) => { throw new Error(`issue1503_cad_cleanup_${code}`, cause ? { cause } : undefined) }
const check = (value, code) => { if (!value) fail(code) }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const safeCode = error => /^issue1503_cad_cleanup_[a-z_]+$/.test(error?.message ?? '')
  ? error.message : 'issue1503_cad_cleanup_operation_failed'

/** Metadata guard; arbitrary caller IDs are never accepted as cleanup scope. */
export function validateSnapshot(state) {
  const { device, agent, bot, issue, runs, profile, dependencies } = state ?? {}
  check(device?.id === FIXTURE.deviceId && device.ownerId === FIXTURE.ownerId && device.kind === 'local'
    && typeof device.enabled === 'boolean' && (!device.removedAt || device.enabled === false), 'device_scope_changed')
  check(bot?.id === FIXTURE.botId && bot.ownerId === FIXTURE.ownerId && bot.workspaceId === FIXTURE.workspaceId, 'bot_scope_changed')
  check(agent?.id === FIXTURE.agentId && agent.userId === FIXTURE.ownerId && agent.harness === 'codex'
    && [null, FIXTURE.deviceId].includes(agent.deviceId), 'agent_scope_changed')
  check(issue?.id === FIXTURE.issueId && issue.userId === FIXTURE.ownerId
    && Number.isInteger(issue.revision) && issue.revision > 0 && Number.isInteger(issue.scopeVersion)
    && ['personal', 'workspace'].includes(issue.scope) && SHA.test(issue.bodySha256 ?? '')
    && SHA.test(issue.titleSha256 ?? '') && issue.testTitle === true, 'issue_scope_changed')
  check(issue.teamLink === null ? issue.scope === 'personal'
    : issue.teamLink?.issueId === FIXTURE.issueId && issue.teamLink.userId === FIXTURE.ownerId
      && issue.teamLink.workspaceId === FIXTURE.workspaceId, 'issue_workspace_changed')
  check(Array.isArray(runs) && runs.length === 2 && new Set(runs.map(run => run.id)).size === 2
    && runs.every(run => RUN_IDS.includes(run.id) && run.userId === FIXTURE.ownerId
      && run.issueId === FIXTURE.issueId && run.botId === FIXTURE.botId && run.deviceId === FIXTURE.deviceId
      && run.agentId === FIXTURE.agentId && (run.status === 'queued' || TERMINAL.has(run.status))), 'run_scope_changed')
  const root = runs.find(run => run.id === FIXTURE.rootRunId), child = runs.find(run => run.id === FIXTURE.childRunId)
  check(root.status === 'failed' && root.stopReason === 'error' && root.retryOf === null && root.continuesRunId === null
    && child.continuesRunId === root.id && child.retryOf === null, 'run_history_changed')
  check(dependencies && ['factoryTasks', 'machineBindings', 'activeBotLeases', 'pendingCoordinatorWork', 'otherLiveProfileRuns', 'foreignDeviceAgents'].every(key => dependencies[key] === 0), 'active_dependency')
  check(profile && UUID.test(profile.id ?? '') && profile.ownerId === FIXTURE.ownerId
    && profile.workspaceId === FIXTURE.workspaceId && profile.historicalMatches === true
    && Number.isInteger(profile.version) && profile.version > 0 && SHA.test(profile.digest ?? '')
    && runs.every(run => run.profileId === profile.id && run.profileVersion === profile.frozenVersion
      && run.profileDigest === profile.frozenDigest && run.profileOwnerId === FIXTURE.ownerId
      && run.profileWorkspaceId === FIXTURE.workspaceId)
    && (profile.archivedAt || (profile.version === profile.frozenVersion && profile.digest === profile.frozenDigest)), 'profile_scope_changed')
  check(/^[a-f0-9]{8}$/.test(profile.fixtureTag ?? ''), 'profile_fixture_unknown')
  return { allRunsTerminal: runs.every(run => TERMINAL.has(run.status)), deviceRemoved: Boolean(device.removedAt),
    issueDeleted: Boolean(issue.deletedAt), profileArchived: Boolean(profile.archivedAt) }
}

function receiptSnapshot(state) {
  const flags = validateSnapshot(state)
  return { ...flags, device: { id: state.device.id, enabled: state.device.enabled, removedAt: iso(state.device.removedAt) },
    issue: { id: state.issue.id, revision: state.issue.revision, scopeVersion: state.issue.scopeVersion,
      deletedAt: state.issue.deletedAt, number: state.issue.number, titleSha256: state.issue.titleSha256, teamLink: state.issue.teamLink },
    runs: state.runs.map(run => ({ id: run.id, status: run.status, stopReason: run.stopReason,
      continuesRunId: run.continuesRunId, stopRequestedAt: iso(run.stopRequestedAt), finishedAt: iso(run.finishedAt) })),
    profile: { id: state.profile.id, version: state.profile.version, frozenVersion: state.profile.frozenVersion,
      digest: state.profile.digest, frozenDigest: state.profile.frozenDigest, archivedAt: iso(state.profile.archivedAt) },
    dependencies: state.dependencies }
}

/** No production I/O on import. A failed operation still leaves its true
 * stage/checkpoint and a bounded readback; it never rewrites failed acceptance. */
export async function cleanupCadFixture(store, { report = {}, checkpoint = async () => {} } = {}) {
  Object.assign(report, { version: 1, issue: 1503, phase: 'cad_app_fixture_cleanup', fixture: FIXTURE,
    startedAt: new Date().toISOString(), status: 'running', actions: [], acceptancePassed: false })
  const step = async (name, work) => {
    report.stage = name; report.actions.push({ name, status: 'attempted' }); await checkpoint(report)
    const result = await work()
    Object.assign(report.actions.at(-1), { status: 'completed', result }); await checkpoint(report)
    return result
  }
  try {
    let state = await store.read(); let flags = validateSnapshot(state)
    report.before = receiptSnapshot(state); await checkpoint(report)
    if (!flags.allRunsTerminal) {
      await step('stop_actual_chain', () => store.stop())
      state = await store.read(); flags = validateSnapshot(state)
      check(flags.allRunsTerminal, 'chain_not_terminal')
    } else report.actions.push({ name: 'stop_actual_chain', status: 'already_terminal_before_operator' })
    if (!flags.deviceRemoved) await step('remove_exact_device', () => store.removeDevice())
    else report.actions.push({ name: 'remove_exact_device', status: 'already_removed_before_operator' })
    state = await store.read(); flags = validateSnapshot(state)
    check(flags.allRunsTerminal && flags.deviceRemoved, 'device_removal_unconfirmed')
    if (!flags.profileArchived) await step('archive_exact_profile', () => store.archiveProfile(state.profile))
    else report.actions.push({ name: 'archive_exact_profile', status: 'already_archived_before_operator' })
    if (!flags.issueDeleted) await step('soft_delete_exact_issue', () => store.deleteIssue(state.issue))
    else report.actions.push({ name: 'soft_delete_exact_issue', status: 'already_deleted_before_operator' })
    report.after = receiptSnapshot(await store.read())
    check(report.after.allRunsTerminal && report.after.deviceRemoved && report.after.profileArchived && report.after.issueDeleted,
      'final_state_incomplete')
    check(report.after.issue.number === report.before.issue.number
      && report.after.issue.titleSha256 === report.before.issue.titleSha256
      && same(report.after.issue.teamLink, report.before.issue.teamLink), 'issue_identity_changed')
    report.credentialReadback = await store.credentials()
    check(report.credentialReadback.unboundedLiveCredentials === 0 && report.credentialReadback.boundAgents === 0,
      'credential_cleanup_incomplete')
    // The old validator's outer finally may already have removed the timing
    // variable. Metadata can reveal a leftover, but no value/name-only deletion
    // is authorized by this script's exact device/issue fixture.
    report.timingVariableReadback = await store.timingVariables(state.profile.fixtureTag)
    check(report.timingVariableReadback.matchingFixtureCount === 0, 'timing_variable_retained')
    report.status = 'passed'; report.stage = 'complete'
  } catch (error) {
    report.status = 'failed'; report.code = safeCode(error)
    try { report.actualFailureState = receiptSnapshot(await store.read()) }
    catch { report.actualFailureStateUnavailable = true }
  } finally {
    report.finishedAt = new Date().toISOString(); await checkpoint(report)
  }
  return report
}

async function createStore() {
  const [{ pool, db }, { workspacePool }, { and, eq, inArray, sql }, schema, metadata,
    { requestRunStop }, { removeOwnedDevice }, { AgentProfileStore }, lists, detail] = await Promise.all([
    import('../../../lib/db'), import('../../../lib/workspace-db'), import('drizzle-orm'), import('../../../lib/db/schema'),
    import('../../../lib/issue-metadata'), import('../../../lib/agent-runs'), import('../../../lib/device-removal'),
    import('../../../lib/factory/agent-profile-store'), import('../../../lib/live/lists'), import('../../../lib/live/issue-detail'),
  ])
  const profiles = new AgentProfileStore(pool)
  const issueState = (row, teamLink) => {
    check(row, 'issue_missing')
    const parsed = metadata.metadataSchema.safeParse(row.content?.attrs?.mikka ?? row.content?.attrs?.orvilo)
    check(parsed.success, 'issue_metadata_invalid')
    return { id: row.id, userId: row.userId, scope: row.scope, scopeVersion: row.scopeVersion, revision: row.revision,
      updatedAt: iso(row.updatedAt), deletedAt: parsed.data.deletedAt, number: parsed.data.number ?? null,
      bodySha256: hash(JSON.stringify(row.content)), titleSha256: hash(row.title), testTitle: /^测试\s*1505\s+\S+\s+codex$/.test(row.title), teamLink }
  }
  const readTeamLink = async () => {
    const { rows } = await workspacePool.query('SELECT "issueId","userId","workspaceId","teamId",number::text AS number FROM mikka_team_issues WHERE "issueId"=$1', [FIXTURE.issueId])
    check(rows.length <= 1, 'issue_workspace_changed'); return rows[0] ?? null
  }
  const read = async () => {
    const [devices, agents, bots, issues, runs, counts, teamLink] = await Promise.all([
      pool.query('SELECT id,"ownerId",kind,enabled,"removedAt" FROM devices WHERE id=$1', [FIXTURE.deviceId]),
      pool.query('SELECT id,"userId",harness,"deviceId" FROM agents WHERE id=$1', [FIXTURE.agentId]),
      pool.query('SELECT id,"ownerId","workspaceId" FROM bots WHERE id=$1', [FIXTURE.botId]),
      pool.query('SELECT id,"userId",title,content,scope,"scopeVersion",revision,"updatedAt" FROM issues WHERE id=$1', [FIXTURE.issueId]),
      pool.query(`SELECT id,"userId","issueId","botId","deviceId","agentId",status,"stopReason","retryOf","continuesRunId",
        "stopRequestedAt","finishedAt","agentDefinition"->'agentProfile'->>'profileId' AS "profileId",
        "agentDefinition"->'agentProfile'->>'version' AS "profileVersion",
        "agentDefinition"->'agentProfile'->>'digest' AS "profileDigest",
        "agentDefinition"->'agentProfile'->'scope'->>'ownerId' AS "profileOwnerId",
        "agentDefinition"->'agentProfile'->'scope'->>'workspaceId' AS "profileWorkspaceId"
        FROM agent_runs WHERE "deviceId"=$1 OR "issueId"=$2 OR id=ANY($3::uuid[]) ORDER BY id`,
      [FIXTURE.deviceId, FIXTURE.issueId, RUN_IDS]),
      pool.query(`SELECT
        (SELECT count(*)::int FROM factory_tasks t WHERE t."issueId"=$1 OR EXISTS(
          SELECT 1 FROM factory_attempts a WHERE a."taskId"=t.id AND a."runId"=ANY($2::uuid[])) OR EXISTS(
          SELECT 1 FROM factory_questions q WHERE q."taskId"=t.id AND (q."originRunId"=ANY($2::uuid[]) OR q."continuationRunId"=ANY($2::uuid[])))) AS "factoryTasks",
        ((SELECT count(*) FROM thread_machines WHERE "runId"=ANY($2::uuid[])) +
         (SELECT count(*) FROM computer_run_bindings WHERE "runId"=ANY($2::uuid[])))::int AS "machineBindings",
        (SELECT count(*)::int FROM coordinator_sessions WHERE "botId"=$3 AND "leaseHolder" IS NOT NULL AND "leaseUntil">now()) AS "activeBotLeases",
        (SELECT count(*)::int FROM coordinator_events WHERE "botId"=$3 AND "userId"=$6 AND "deliveredAt" IS NULL
          AND (kind='user_message' OR tier IS NULL OR tier<>'background' OR "wakeLeaseUntil">now())) AS "pendingCoordinatorWork",
        (SELECT count(*)::int FROM agents WHERE "deviceId"=$4 AND (id<>$5 OR "userId"<>$6)) AS "foreignDeviceAgents"`,
      [FIXTURE.issueId, RUN_IDS, FIXTURE.botId, FIXTURE.deviceId, FIXTURE.agentId, FIXTURE.ownerId]),
      readTeamLink(),
    ])
    const root = runs.rows.find(run => run.id === FIXTURE.rootRunId)
    check(root && UUID.test(root.profileId ?? '') && /^[1-9][0-9]*$/.test(root.profileVersion ?? ''), 'profile_reference_missing')
    const { rows: [profile] } = await pool.query(`SELECT p.id,p."ownerId",p."workspaceId",p.version,p.digest,p."archivedAt",
      v.definition->>'name' AS name,$2::integer AS "frozenVersion",r."agentDefinition"->'agentProfile'->>'digest' AS "frozenDigest",
      COALESCE(v.digest=r."agentDefinition"->'agentProfile'->>'digest' AND v.definition=r."agentDefinition"->'agentProfile'->'definition',false) AS "historicalMatches",
      (SELECT count(*)::int FROM agent_runs other WHERE other."agentDefinition"->'agentProfile'->>'profileId'=p.id::text
        AND other.status=ANY($4::text[]) AND NOT(other.id=ANY($5::uuid[]))) AS "otherLiveProfileRuns"
      FROM factory_agent_profiles p JOIN agent_runs r ON r.id=$3
      LEFT JOIN factory_agent_profile_versions v ON v."profileId"=p.id AND v.version=$2
        AND v."ownerId"=p."ownerId" AND v."workspaceId"=p."workspaceId"
      WHERE p.id=$1`, [root.profileId, Number(root.profileVersion), FIXTURE.rootRunId, LIVE, RUN_IDS])
    if (profile) profile.fixtureTag = /^测试1505 ([a-f0-9]{8}) codex$/.exec(profile.name ?? '')?.[1] ?? null
    return { device: devices.rows[0], agent: agents.rows[0], bot: bots.rows[0], issue: issueState(issues.rows[0], teamLink),
      runs: runs.rows.map(run => ({ ...run, profileVersion: Number(run.profileVersion) })), profile,
      dependencies: { ...counts.rows[0], otherLiveProfileRuns: profile?.otherLiveProfileRuns ?? -1 } }
  }
  return {
    read,
    async stop() {
      const before = await read(); const flags = validateSnapshot(before)
      if (flags.allRunsTerminal) return { alreadyTerminalAtCall: true, stoppedRunIds: [] }
      const result = await requestRunStop(FIXTURE.ownerId, FIXTURE.rootRunId)
      check(Array.isArray(result.stoppedRunIds) && result.stoppedRunIds.every(id => RUN_IDS.includes(id)), 'stop_target_changed')
      return { stoppedRunIds: result.stoppedRunIds }
    },
    async removeDevice() { return removeOwnedDevice(FIXTURE.ownerId, FIXTURE.deviceId) },
    async archiveProfile(profile) {
      const value = await profiles.archive({ ownerId: FIXTURE.ownerId, workspaceId: FIXTURE.workspaceId }, profile.id, profile.version)
      check(value.id === profile.id && value.archivedAt && value.enabled === false, 'profile_archive_unconfirmed')
      return { id: value.id, version: value.version, archivedAt: value.archivedAt }
    },
    async deleteIssue(expected) {
      return db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
        await tx.execute(sql`SET LOCAL statement_timeout='30s'`)
        const [row] = await tx.select().from(schema.issues).where(and(eq(schema.issues.id, FIXTURE.issueId),
          eq(schema.issues.userId, FIXTURE.ownerId))).for('update')
        check(same(issueState(row, await readTeamLink()), expected), 'issue_cas_changed')
        const live = await tx.select({ id: schema.agentRuns.id }).from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.issueId, FIXTURE.issueId), inArray(schema.agentRuns.status, LIVE))).limit(1)
        check(live.length === 0, 'issue_has_live_run')
        const factory = await tx.execute(sql`SELECT 1 FROM factory_tasks WHERE "issueId"=${FIXTURE.issueId} LIMIT 1`)
        check(factory.rows.length === 0, 'issue_has_factory_task')
        const waking = await tx.execute(sql`SELECT 1 FROM coordinator_events WHERE "botId"=${FIXTURE.botId} AND "userId"=${FIXTURE.ownerId}
          AND "deliveredAt" IS NULL AND (kind='user_message' OR tier IS NULL OR tier<>'background' OR "wakeLeaseUntil">now()) LIMIT 1`)
        check(waking.rows.length === 0, 'coordinator_work_changed')
        const before = metadata.readIssueMetadata(row.content)
        const [saved] = await tx.update(schema.issues).set({
          content: metadata.withIssueMetadata(row.content, { ...before, deletedAt: new Date().toISOString() }),
          revision: row.revision + 1, updatedAt: new Date(),
        }).where(and(eq(schema.issues.id, row.id), eq(schema.issues.userId, FIXTURE.ownerId),
          eq(schema.issues.revision, expected.revision), eq(schema.issues.scopeVersion, expected.scopeVersion))).returning()
        check(saved && metadata.readIssueMetadata(saved.content).number === before.number, 'issue_write_unconfirmed')
        await lists.issueListChanged(tx, saved.id, true)
        await detail.issueRelationsChanged(tx, [saved.id])
        return { id: saved.id, revision: saved.revision, deletedAt: metadata.readIssueMetadata(saved.content).deletedAt }
      })
    },
    async credentials() {
      const { rows: [row] } = await pool.query(`SELECT
        (SELECT count(*)::int FROM agents WHERE "deviceId"=$1) AS "boundAgents",
        (SELECT count(*)::int FROM device_tokens t WHERE t."userId"=$2 AND t."revokedAt" IS NULL
          AND (t."boundDeviceId"=$1 OR EXISTS(SELECT 1 FROM device_token_devices b WHERE b."tokenId"=t.id AND b."deviceId"=$1))
          AND (t."expiresAt" IS NULL OR t."expiresAt">now()+interval '10 minutes')) AS "unboundedLiveCredentials",
        (SELECT count(*)::int FROM device_tokens t WHERE t."userId"=$2 AND t."revokedAt" IS NULL AND t."expiresAt">now()
          AND (t."boundDeviceId"=$1 OR EXISTS(SELECT 1 FROM device_token_devices b WHERE b."tokenId"=t.id AND b."deviceId"=$1))) AS "gracePeriodCredentials"`,
      [FIXTURE.deviceId, FIXTURE.ownerId])
      return row
    },
    async timingVariables(tag) {
      const { rows } = await pool.query(`SELECT id,"createdAt","updatedAt" FROM workspace_secrets
        WHERE "workspaceId"=$1 AND name='CLOUD_STARTUP_TIMING' AND kind='env' AND "scopeType"='repository'
          AND lower("scopeRef")='alexj11324/mikka-handoff' AND "createdBy"=$2
          AND note ~ $3 ORDER BY id`, [FIXTURE.workspaceId, FIXTURE.ownerId, `^测试1505 ${tag}-[a-f0-9-]+$`])
      return { matchingFixtureCount: rows.length, retained: rows.map(row => ({ id: row.id, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })),
        valuesRead: false, mutated: false }
    },
    async close() { await Promise.all([pool.end(), workspacePool.end()]) },
  }
}

function workflowIdentity(env) {
  check(env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_REF === 'refs/heads/ops/issue-1503-cad-app-cleanup'
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '')
    && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'workflow_identity_invalid')
  return { repository: env.GITHUB_REPOSITORY, sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT }
}

export async function createConfiguredStore(env, report, checkpoint, create = createStore) {
  report.identity = workflowIdentity(env)
  report.stage = 'configuration'; await checkpoint()
  for (const name of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) {
    let url; try { url = new URL(env[name]) } catch (error) { fail('database_configuration_missing', error) }
    check(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname.endsWith('.neon.tech'), 'database_target_invalid')
  }
  check(env.NODE_ENV === 'production' && env.VERCEL_ENV === 'production'
    && env.DEVICE_GATEWAY_PUSH_SECRET, 'runtime_configuration_missing')
  let gateway; try { gateway = new URL(env.DEVICE_GATEWAY_URL) } catch (error) { fail('gateway_configuration_missing', error) }
  check(gateway.protocol === 'https:' && !gateway.username && !gateway.password, 'gateway_configuration_invalid')
  // Normal services import lib/auth; its asynchronous production initialization
  // rejects without the real secret even though this operator never signs in.
  check(typeof env.BETTER_AUTH_SECRET === 'string' && env.BETTER_AUTH_SECRET.trim().length > 0,
    'auth_configuration_missing')
  check(env.BETTER_AUTH_URL === 'https://app.aspectlylabs.com', 'auth_origin_invalid')
  report.stage = 'service_import'; await checkpoint()
  return create()
}

async function main() {
  const output = resolve('issue1503-report/cad-app-cleanup.json')
  const report = { version: 1, issue: 1503, phase: 'cad_app_fixture_cleanup', status: 'starting' }
  const checkpoint = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
  const contextSymbol = Symbol.for('@vercel/request-context'), prior = globalThis[contextSymbol], pending = []
  let store
  try {
    // Existing non-Next waitUntil contract; drain real commit notifications
    // before closing pools. This is not a user session or an auth substitute.
    globalThis[contextSymbol] = { get: () => ({ waitUntil: promise => pending.push(Promise.resolve(promise)) }) }
    store = await createConfiguredStore(process.env, report, checkpoint)
    report.stage = 'read_exact_fixture'; await checkpoint()
    await cleanupCadFixture(store, { report, checkpoint })
  } catch (error) { report.status = 'failed'; report.code = safeCode(error) }
  finally {
    let awaited = 0
    while (pending.length) { const batch = pending.splice(0); awaited += batch.length; await Promise.allSettled(batch) }
    report.background = { waitUntilPromisesAwaited: awaited, deliveryAcknowledgementProven: false }
    globalThis[contextSymbol] = prior
    if (store) try { await store.close() } catch { report.status = 'failed'; report.closeCode = 'database_close_failed' }
    report.finishedAt = new Date().toISOString(); await checkpoint()
  }
  process.stdout.write(JSON.stringify({ status: report.status, code: report.code ?? null, report: 'issue1503-report/cad-app-cleanup.json' }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => { process.stderr.write('issue1503_cad_cleanup_receipt_failed\n'); process.exitCode = 1 })
}
