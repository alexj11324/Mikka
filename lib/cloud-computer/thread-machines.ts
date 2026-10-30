import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { Sandbox } from 'e2b'
import { z } from 'zod'
import { ComputerError } from '@/lib/computer/store'
import { computerPermission } from '@/lib/computer/permission'
import { connectComputer, installComputerRuntime, startDesktop, syncDesktopLease, viewerGrant, ensureHostedRunnerImage } from '@/lib/computer/e2b-provider'
import { installSubagentRuntime, runtimeRequest } from './runtime'
import { threadMachineLimits, threadMachineViolation, type ThreadMachineLimits } from './thread-machine-limits'
import type { Actor } from './subagents'
import { afterRunEnded } from '@/lib/run-completion-effects'
function options() {
  const key = process.env.E2B_API_KEY
  if (!key) throw new Error('Cloud runtime unavailable')
  return { apiKey: key, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
/** Register only while this provisioning lease still owns a non-ended row. */
export async function recordThreadSandbox(pool: Pick<Pool, 'query'>, runId: string, sandboxId: string, leaseId: string) {
  return Boolean((await pool.query('UPDATE thread_machines SET "sandboxId"=$2 WHERE "runId"=$1 AND "workerLeaseId"=$3 AND state<>\'ended\' RETURNING "runId"', [runId, sandboxId, leaseId])).rowCount)
}
export async function recordCancelledSandbox(pool: Pick<Pool, 'query'>, runId: string, sandboxId: string, operationId: string) {
  return Boolean((await pool.query('UPDATE thread_machines SET "sandboxId"=$2,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND state=\'ended\' AND "operationId"=$3 AND "sandboxId" IS NULL RETURNING "runId"', [runId, sandboxId, operationId])).rowCount)
}
/** Capture filesystem only. A cloned memory image would duplicate live daemon
 * credentials/connections. Cache is always bound to one owner and workspace. */
async function workspaceSnapshot(pool: Pool, actor: Actor, source: Sandbox, repoPath: string) {
  const revision = (await source.commands.run(`git -C ${quote(repoPath)} rev-parse HEAD`, { user: 'mikka-runner', timeoutMs: 10_000 })).stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new ComputerError(409, 'Workspace source unavailable')
  const lock = (await source.commands.run(`cd ${quote(repoPath)} && for f in pnpm-lock.yaml package-lock.json yarn.lock; do if test -f "$f"; then sha256sum "$f"; fi; done`, { user: 'mikka-runner', timeoutMs: 10_000 })).stdout
  const lockDigest = createHash('sha256').update(lock).digest('hex')
  const old = (await pool.query('SELECT * FROM workspace_snapshots WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])).rows[0]
  if (old && old.sourceRevision === revision && old.lockDigest === lockDigest && Date.now() - new Date(old.createdAt).getTime() < 24 * 60 * 60_000) return old.snapshotId as string
  const snapshot = await source.createSnapshot({ mode: 'filesystem' })
  await pool.query(`INSERT INTO workspace_snapshots ("workspaceId","ownerId","sourceRevision","lockDigest","snapshotId") VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT ("workspaceId","ownerId") DO UPDATE SET "sourceRevision"=$3,"lockDigest"=$4,"snapshotId"=$5,"createdAt"=now()`, [actor.workspaceId, actor.userId, revision, lockDigest, snapshot.snapshotId])
  return snapshot.snapshotId
}
/** Hard spend guard. Counts running machines and E2B-billed compute seconds:
 * paused sandboxes are not billed, so only tracked running intervals count.
 * The caller holds the workspace and owner advisory locks so two provisioning
 * runs cannot both observe the last slot. */
export async function assertThreadMachineCapacity(
  client: Pick<PoolClient, 'query'>,
  actor: Actor,
  runId: string,
  limits: ThreadMachineLimits = threadMachineLimits(),
) {
  const { rows: [active] } = await client.query<{ ownerActive: number; workspaceActive: number }>(
    `SELECT count(*) FILTER (WHERE "ownerId"=$2)::int AS "ownerActive", count(*)::int AS "workspaceActive"
      FROM thread_machines WHERE "workspaceId"=$1 AND state IN ('starting','running') AND "runId"<>$3`,
    [actor.workspaceId, actor.userId, runId],
  )
  const { rows: [used] } = await client.query<{ ownerComputeHours: number | string }>(
    `SELECT COALESCE(sum("computeSeconds" + CASE WHEN "runningSince" IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")) END),0) / 3600.0 AS "ownerComputeHours"
      FROM thread_machines WHERE "ownerId"=$1 AND "createdAt">clock_timestamp()-interval '30 days'`,
    [actor.userId],
  )
  const violation = threadMachineViolation({
    ownerActive: active.ownerActive,
    workspaceActive: active.workspaceActive,
    ownerComputeHours: Number(used.ownerComputeHours),
  }, limits)
  if (violation === 'owner') throw new ComputerError(429, 'Thread machine limit reached')
  if (violation === 'workspace') throw new ComputerError(429, 'Workspace machine limit reached')
  if (violation === 'budget') throw new ComputerError(429, 'Thread machine budget exhausted')
}

/** Provider calls of ensureThreadMachine; tests replace them, production uses E2B. */
export const threadMachineProvider = {
  snapshot: async (client: PoolClient, actor: Actor, botSandboxId: string, repoPath: string) =>
    workspaceSnapshot(client as unknown as Pool, actor, await connectComputer(botSandboxId), repoPath),
  connect: (sandboxId: string) => connectComputer(sandboxId),
  create: (snapshotId: string, operationId: string, metadata: Record<string, string>) =>
    Sandbox.create(snapshotId, { ...options(), idempotencyKey: operationId, timeoutMs: 15 * 60_000, metadata, lifecycle: { onTimeout: 'pause', autoResume: false } }),
  kill: async (sandboxId: string) => { await Sandbox.kill(sandboxId, options()) },
}

/**
 * A queued run whose stop was requested while it has a machine binding (stopOwnedRun leaves
 * those to the machine lifecycle) ends here instead of provisioning. The caller is inside
 * BEGIN and holds the agent_runs row lock. Same writes as the 'end' action: run 'stopped',
 * machine 'ended' (sandboxId kept so a failed kill stays retryable; a lease another worker
 * still holds keeps workerLeaseUntil so that worker cleans up its own sandbox). Commits and
 * returns the sandbox to kill, if any.
 */
async function endStopRequestedRun(client: PoolClient, actor: Actor, runId: string) {
  const m = (await client.query('SELECT "sandboxId","workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [runId])).rows[0]
  const pending = Boolean(m && !m.sandboxId && (m.workerLeaseId || m.workerLeaseUntil))
  await client.query(`UPDATE agent_runs SET status='stopped',"finishedAt"=COALESCE("finishedAt",now()),"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND status='queued'`, [runId, actor.userId])
  if (m) await client.query('UPDATE thread_machines SET state=\'ended\',"endedAt"=COALESCE("endedAt",now()),"computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL,"workerLeaseId"=NULL,"workerLeaseUntil"=CASE WHEN $2 THEN COALESCE("workerLeaseUntil",now()) ELSE NULL END WHERE "runId"=$1', [runId, pending])
  await client.query('COMMIT')
  return (m?.sandboxId as string | null) ?? null
}

/** The queued run is moved to a dedicated device before any worker can claim
 * it. Bot workers are denied these runs by claimCloudRun. */
export async function ensureThreadMachine(pool: Pool, actor: Actor, runId: string, provider = threadMachineProvider) {
  z.uuid().parse(runId)
  const client = await pool.connect()
  const leaseId = randomUUID()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-machine:${runId}`])
    const run = (await client.query(`SELECT r.*,b."workspaceId",b."botId" AS "runtimeBotId",repo."repoPath",repo."remoteUrl",repo."baseBranch",repo."verifyCommand",COALESCE(source_repo."repoPath",repo."repoPath") AS "snapshotRepoPath",m."sandboxId" AS "botSandboxId"
      FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
      LEFT JOIN bot_cloud_runtimes runtime ON runtime."botId"=b."botId" AND runtime."ownerId"=b."ownerId" AND runtime."workspaceId"=b."workspaceId" AND runtime."agentId"=r."agentId"
      LEFT JOIN device_repos source_repo ON source_repo.id=runtime."repoId" AND source_repo."userId"=r."userId"
      WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 FOR UPDATE OF r`, [runId, actor.userId, actor.workspaceId])).rows[0]
    if (!run || !run.botSandboxId || !['queued', 'preparing', 'running', 'waiting_input'].includes(run.status)) throw new ComputerError(404, 'Thread unavailable')
    // Stop check 1, before any provider call, under the run lock stopOwnedRun also takes.
    if (run.status === 'queued' && run.stopRequestedAt) {
      const stale = await endStopRequestedRun(client, actor, runId)
      await afterRunEnded(actor.userId, runId)
      if (stale) await provider.kill(stale)
      throw new ComputerError(409, 'Thread stopped')
    }
    let machine = (await client.query('SELECT * FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [runId])).rows[0]
    if (machine?.state === 'ended') throw new ComputerError(409, 'Thread ended')
    if (machine?.state === 'running' && machine.sandboxId) {
      const state = await Sandbox.getInfo(machine.sandboxId, options())
      if (state.state !== 'paused') { await client.query('COMMIT'); return { runId, state: 'running' } }
      // The provider paused this sandbox on its own timeout. E2B stops billing
      // at pause, so persist the end of the running interval before resuming.
      await client.query(`UPDATE thread_machines SET "computeSeconds"="computeSeconds"+GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,"runningSince"=NULL,state='paused' WHERE "runId"=$1 AND "runningSince" IS NOT NULL`, [runId])
      machine.state = 'paused'
    }
    if (machine?.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now() && machine.state !== 'paused') throw new ComputerError(409, 'Thread provisioning in progress')
    // The workspace lock is taken first so owners in one workspace cannot race
    // the shared slot; the owner lock then covers their own budget.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-machines:ws:${actor.workspaceId}`])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-machines:owner:${actor.userId}`])
    await assertThreadMachineCapacity(client, actor, runId)
    if (!machine || machine.snapshotId === 'pending') {
      const snapshotId = await provider.snapshot(client, actor, run.botSandboxId, run.snapshotRepoPath)
      machine = (await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state)
        VALUES ($1,$2,$3,$4,$5,$6,'starting') ON CONFLICT ("runId") DO UPDATE SET "snapshotId"=EXCLUDED."snapshotId" RETURNING *`, [runId, actor.workspaceId, actor.userId, run.runtimeBotId, snapshotId, randomUUID()])).rows[0]
    }
    // Persist snapshot and operation ID before provider requests.
    await client.query('UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval \'15 minutes\' WHERE "runId"=$1', [runId, leaseId])
    await client.query('COMMIT')
    const sandbox = machine.sandboxId ? await provider.connect(machine.sandboxId) : await provider.create(machine.snapshotId, machine.operationId, { application: 'mikka-thread', workspaceId: actor.workspaceId, runId })
    const recorded = await recordThreadSandbox(pool, runId, sandbox.sandboxId, leaseId)
    if (!recorded) {
      // An end can win while Sandbox.create is in flight. The just-created
      // sandbox is not in the row end observed, so this worker must clean it up.
      if (!machine.sandboxId) {
        // Record it even after end so a failed kill remains retryable. A newer
        // lease may share the idempotent sandbox and must not have it killed.
        if (await recordCancelledSandbox(pool, runId, sandbox.sandboxId, machine.operationId)) await provider.kill(sandbox.sandboxId)
      }
      throw new ComputerError(409, 'Thread provisioning cancelled')
    }
    // Stop check 2: a stop may have landed while the first transaction was committed and the
    // sandbox was being created. Re-take the run lock and check again before the worker starts.
    await client.query('BEGIN')
    const again = (await client.query('SELECT status,"stopRequestedAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])).rows[0]
    if (again?.status === 'queued' && again.stopRequestedAt) {
      const stale = await endStopRequestedRun(client, actor, runId)
      await afterRunEnded(actor.userId, runId)
      if (stale) await provider.kill(stale)
      throw new ComputerError(409, 'Thread stopped')
    }
    await client.query('COMMIT')
    if (!machine.sandboxId) {
      // Filesystem snapshots start no old worker process. Remove copied device
      // identity/capabilities before a new worker can make any network call.
      await sandbox.commands.run('rm -rf /home/mikka-runner/.mikka/worker /home/mikka-runner/.mikka/bootstrap.json /run/mikka-viewer /run/mikka-subagents; install -d -m 700 /run/mikka-viewer', { user: 'root', timeoutMs: 10_000 })
    }
    await installComputerRuntime(sandbox)
    await ensureHostedRunnerImage(sandbox)
    const deviceId = machine.deviceId ?? randomUUID()
    const repoId = machine.repoId ?? randomUUID()
    const credential = `orv_${randomBytes(32).toString('base64url')}`
    const origin = new URL(process.env.MIKKA_CLOUD_WORKER_URL ?? '')
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('Worker unavailable')
    const expectedSha = process.env.MIKKA_CLOUD_WORKER_SHA
    const sourceSha = (await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim()
    if (!expectedSha || sourceSha !== expectedSha) throw new Error('Worker version mismatch')
    await client.query('BEGIN')
    // Provision, end and desktop all lock the parent run before its machine.
    await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])
    const activeLease = await client.query('SELECT 1 FROM thread_machines WHERE "runId"=$1 AND "workerLeaseId"=$2 AND state<>\'ended\' FOR UPDATE', [runId, leaseId])
    if (!activeLease.rowCount) throw new ComputerError(409, 'Thread provisioning cancelled')
    await client.query('INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,$3,\'cloud\') ON CONFLICT(id) DO NOTHING', [deviceId, actor.userId, 'Thread computer'])
    await client.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch","verifyCommand","remoteUrl") VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', [repoId, deviceId, actor.userId, run.repoPath, run.baseBranch, run.verifyCommand,run.remoteUrl])
    await client.query('UPDATE thread_machines SET "deviceId"=$2,"repoId"=$3 WHERE "runId"=$1', [runId, deviceId, repoId])
    await client.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1', [deviceId])
    await client.query('INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval \'24 hours\')', [randomUUID(), actor.userId, 'Thread worker', createHash('sha256').update(credential).digest('hex'), deviceId, actor.workspaceId])
    await client.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3 WHERE id=$1 AND "userId"=$4 AND status=\'queued\'', [runId, deviceId, repoId, actor.userId])
    await client.query('COMMIT')
    const handoff = `/run/mikka-viewer/thread-${leaseId}.json`
    await sandbox.files.write(handoff, JSON.stringify({ deviceId, workspaceId: actor.workspaceId, credential, server: origin.toString(), ...(process.env.VERCEL_ENV === 'preview' && process.env.MIKKA_CLOUD_PREVIEW_BYPASS ? { protectionBypass: process.env.MIKKA_CLOUD_PREVIEW_BYPASS } : {}) }), { user: 'root' })
    await sandbox.commands.run(`install -d -o mikka-runner -g mikka-runner -m 700 /home/mikka-runner/.mikka; install -o mikka-runner -g mikka-runner -m 600 ${handoff} /home/mikka-runner/.mikka/bootstrap.json; unlink ${handoff}`, { user: 'root', timeoutMs: 10_000 })
    await sandbox.commands.run('cd /opt/mikka/worker/packages/daemon && HOME=/home/mikka-runner ./node_modules/.bin/tsx bin/cloud-worker.ts > /home/mikka-runner/.mikka/thread-bootstrap.log 2>&1', { user: 'mikka-runner', background: true, timeoutMs: 0 })
    const deadline = Date.now() + 30_000
    let ready = false
    do {
      ready = Boolean((await pool.query('SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND "lastSeenAt">now()-interval \'30 seconds\'', [deviceId, actor.userId])).rowCount)
      if (!ready) await new Promise(resolve => setTimeout(resolve, 500))
    } while (!ready && Date.now() < deadline)
    if (!ready) throw new Error('Thread worker did not register')
    const finished = await pool.query('UPDATE thread_machines SET state=\'running\',"lastActiveAt"=now(),"runningSince"=now(),"workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND "workerLeaseId"=$2 AND state<>\'ended\' RETURNING "runId"', [runId, leaseId])
    if (!finished.rowCount) throw new ComputerError(409, 'Thread provisioning cancelled')
    return { runId, state: 'running' }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

const desktopRuntime = { connectComputer, startDesktop, syncDesktopLease, installSubagentRuntime, runtimeRequest, viewerGrant }
/** A thread's desktop keeps the same current workspace policy as the Bot
 * desktop. The policy lock also fences concurrent administrative revocation. */
export async function openThreadDesktop(pool: Pool, actor: Actor, runId: string, runtime = desktopRuntime) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const run = (await client.query('SELECT "deviceId" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR SHARE', [runId, actor.userId])).rows[0]
    if (!run?.deviceId) throw new ComputerError(404, 'Thread unavailable')
    const machine = (await client.query(`SELECT t.* FROM thread_machines t
      JOIN computer_run_bindings bnd ON bnd."runId"=t."runId" AND bnd."botId"=t."botId" AND bnd."workspaceId"=t."workspaceId" AND bnd."ownerId"=t."ownerId"
      JOIN devices d ON d.id=t."deviceId" AND d."ownerId"=t."ownerId" AND d.kind='cloud' AND d.enabled=true
      JOIN bots b ON b.id=t."botId" AND b."ownerId"=t."ownerId" AND b."workspaceId"=t."workspaceId"
      WHERE t."runId"=$1 AND t."ownerId"=$2 AND t."workspaceId"=$3 AND t."deviceId"=$4 AND t.state<>'ended' AND t."sandboxId" IS NOT NULL
      FOR UPDATE OF t FOR SHARE OF d`, [runId, actor.userId, actor.workspaceId, run.deviceId])).rows[0]
    if (!machine) throw new ComputerError(404, 'Thread unavailable')
    const policy = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
    const permission = computerPermission(policy?.permission), policyVersion = Number(policy?.version ?? 0)
    if (permission === 'deny') throw new ComputerError(403, 'Computer use is disabled')
    if (permission !== 'allow' || !Number.isSafeInteger(policyVersion) || policyVersion < 0) throw new ComputerError(409, 'Computer policy unavailable')
    const sandbox = await runtime.connectComputer(machine.sandboxId)
    const lease = { botId: machine.botId, ownerId: actor.userId, display: 1, epoch: machine.epoch, controlledBy: null, controlUntil: 0, computerAllowed: true, policyVersion }
    await runtime.startDesktop(sandbox, 1, true)
    await runtime.syncDesktopLease(sandbox, lease)
    await runtime.installSubagentRuntime(sandbox, actor.userId)
    const browser = await runtime.runtimeRequest(machine.sandboxId, { id: runId, ownerId: actor.userId, workspaceId: actor.workspaceId, botId: machine.botId, epoch: machine.epoch, display: 1 }, '/start', {})
    await client.query('UPDATE thread_machines SET "targetId"=$2 WHERE "runId"=$1', [runId, browser.targetId])
    const viewer = await runtime.viewerGrant(sandbox, lease, actor.userId, 'view')
    await client.query('COMMIT')
    return { runId, state: machine.state, ...viewer }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function threadMachineAction(pool: Pool, actor: Actor, runId: string, action: 'pause' | 'resume' | 'end' | 'desktop') {
  const machine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!machine || (machine.state === 'ended' && action !== 'end')) throw new ComputerError(404, 'Thread unavailable')
  if (action === 'end') {
    // Fence provisioning and revoke any existing token before provider I/O.
    // Retain the sandbox ID so a failed or lost kill response can be retried.
    const client = await pool.connect()
    let sandboxId: string | null
    let creationPending: boolean
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])
      const locked = (await client.query('SELECT "sandboxId","deviceId","workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE', [runId, actor.userId, actor.workspaceId])).rows[0]
      if (!locked) throw new ComputerError(404, 'Thread unavailable')
      sandboxId = locked.sandboxId
      creationPending = !sandboxId && Boolean(locked.workerLeaseId || locked.workerLeaseUntil)
      await client.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"=COALESCE("stopRequestedAt",now()),"finishedAt"=COALESCE("finishedAt",now())
        WHERE id=$1 AND "userId"=$2 AND status NOT IN ('succeeded','failed','stopped','cancelled')`, [runId, actor.userId])
      await client.query('UPDATE thread_machines SET state=\'ended\',"endedAt"=COALESCE("endedAt",now()),"computeSeconds"="computeSeconds"+GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,"runningSince"=NULL,"workerLeaseId"=NULL,"workerLeaseUntil"=CASE WHEN $2 THEN COALESCE("workerLeaseUntil",now()) ELSE NULL END WHERE "runId"=$1', [runId, creationPending])
      await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1', [locked.deviceId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    // This is a terminal write outside the daemon completion path: finalize a
    // bound Factory task after commit. Flag-gated, idempotent, never throws.
    await afterRunEnded(actor.userId, runId)
    if (creationPending) throw new ComputerError(409, 'Thread creation cleanup pending')
    // Run end has fenced new captures. Preserve existing recordings before
    // destroying the dedicated filesystem that still holds their bytes.
    const { screenCaptures } = await import('@/lib/captures/screen')
    await screenCaptures.stopRunRecordings([runId])
    if (sandboxId) await Sandbox.kill(sandboxId, options())
    return { runId, state: 'ended' }
  }
  if (action === 'resume') return ensureThreadMachine(pool, actor, runId)
  if (action === 'desktop') return openThreadDesktop(pool, actor, runId)
  if (!machine.sandboxId) throw new ComputerError(409, 'Thread machine has not started')
  const sandbox = await connectComputer(machine.sandboxId)
  if (action === 'pause') {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const run = (await client.query('SELECT status FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])).rows[0]
      if (run?.status !== 'queued') throw new ComputerError(409, 'Only an idle unclaimed thread can pause; an active run keeps its lease')
      await sandbox.pause()
      await client.query(`UPDATE thread_machines SET state='paused',"computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL WHERE "runId"=$1`, [runId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  return { runId, state: action === 'pause' ? 'paused' : machine.state }
}
