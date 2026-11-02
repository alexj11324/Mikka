import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { NotFoundError, Sandbox, SandboxNotFoundError } from 'e2b'
import { z } from 'zod'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { matchesRepositoryAdmission } from '@/lib/repository-admission'
import { ComputerError } from '@/lib/computer/store'
import { computerPermission } from '@/lib/computer/permission'
import { connectComputer, installComputerRuntime, startDesktop, syncDesktopLease, viewerGrant } from '@/lib/computer/e2b-provider'
import { CLOUD_WORKER_COMMAND } from '@/lib/computer/worker-command'
import { installSubagentRuntime, runtimeRequest } from './runtime'
import { e2bApiKey, taskTemplate, withE2BErrors } from '@/lib/secrets/e2b-runtime'
import type { Actor } from './subagents'
import { afterRunEnded } from '@/lib/run-completion-effects'
import { workspaceSecretMasker } from '@/lib/secrets/runtime'
import { readWorkerTail, saveWorkerTail, workerCommand, workerOutputForwarder } from './thread-worker-logs'
import { credentialProbeCommand, credentialScrubCommand } from '../../packages/daemon/src/credential-globs'
/** A thread machine runs on its owner's own E2B key (orchestration § 2); this module only acts for that owner. */
async function options(ownerId: string) {
  return { apiKey: await e2bApiKey(ownerId, 'Cloud runtime unavailable'), proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
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
 * credentials/connections. Cache is always bound to one owner and workspace.
 * Never captures a credential (decision 2026-10-31-2225): while one is on the
 * bot machine (a coding-CLI login, a run's GitHub token, a live broker), the
 * last clean snapshot is reused, or the thread waits with a refusal. */
export async function workspaceSnapshot(pool: Pick<Pool, 'query'>, actor: Actor, source: Pick<Sandbox, 'commands' | 'createSnapshot'>, repoPath: string) {
  const revision = (await source.commands.run(`git -C ${quote(repoPath)} rev-parse HEAD`, { user: 'user', timeoutMs: 10_000 })).stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new ComputerError(409, 'Workspace source unavailable')
  const lock = (await source.commands.run(`cd ${quote(repoPath)} && for f in pnpm-lock.yaml package-lock.json yarn.lock; do if test -f "$f"; then sha256sum "$f"; fi; done`, { user: 'user', timeoutMs: 10_000 })).stdout
  const lockDigest = createHash('sha256').update(lock).digest('hex')
  const old = (await pool.query('SELECT * FROM workspace_snapshots WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])).rows[0]
  if (old && old.sourceRevision === revision && old.lockDigest === lockDigest && Date.now() - new Date(old.createdAt).getTime() < 24 * 60 * 60_000) return old.snapshotId as string
  const found = (await source.commands.run(credentialProbeCommand(), { user: 'root', timeoutMs: 10_000 })).stdout.split('\n').filter(Boolean)
  if (found.length) {
    // Paths only, never contents; the count is enough to find it in logs.
    console.warn('Workspace snapshot skipped: credentials present', { count: found.length })
    if (old) return old.snapshotId as string
    throw new ComputerError(409, 'Workspace snapshot unavailable')
  }
  const snapshot = await source.createSnapshot({ mode: 'filesystem' })
  await pool.query(`INSERT INTO workspace_snapshots ("workspaceId","ownerId","sourceRevision","lockDigest","snapshotId") VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT ("workspaceId","ownerId") DO UPDATE SET "sourceRevision"=$3,"lockDigest"=$4,"snapshotId"=$5,"createdAt"=now()`, [actor.workspaceId, actor.userId, revision, lockDigest, snapshot.snapshotId])
  return snapshot.snapshotId
}
/** The provider no longer has this sandbox (deleted, expired or killed outside Mikka). */
export function sandboxGone(error: unknown) {
  if (error instanceof SandboxNotFoundError) return true
  const status = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode : undefined
  return error instanceof NotFoundError || status === 404
}

/**
 * Forgets a thread's lost sandbox so a new one is created for the same thread
 * (orchestration.md § 4): a new operation ID, the running interval closed.
 * With a lease, only that lease's row is reset.
 */
async function replaceGoneSandbox(query: Pick<Pool, 'query'>, runId: string, leaseId?: string) {
  return (await query.query(`UPDATE thread_machines SET "sandboxId"=NULL,"operationId"=$2,state='starting',
      "computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL
    WHERE "runId"=$1 AND state<>'ended' AND ($3::uuid IS NULL OR "workerLeaseId"=$3) RETURNING *`, [runId, randomUUID(), leaseId ?? null])).rows[0]
}

/** Provider calls of ensureThreadMachine; tests replace them, production uses E2B. */
export const threadMachineProvider = {
  snapshot: async (client: PoolClient, actor: Actor, botSandboxId: string, repoPath: string) =>
    workspaceSnapshot(client as unknown as Pool, actor, await connectComputer(actor.workspaceId, botSandboxId), repoPath),
  connect: (sandboxId: string, workspaceId: string) => connectComputer(workspaceId, sandboxId),
  create: async (snapshotId: string, operationId: string, metadata: Record<string, string>, ownerId: string) => {
    const base = await options(ownerId)
    return withE2BErrors(ownerId, true, () => Sandbox.create(snapshotId, { ...base, idempotencyKey: operationId, timeoutMs: 15 * 60_000, metadata, lifecycle: { onTimeout: 'pause', autoResume: false } }))
  },
  kill: async (sandboxId: string, ownerId: string) => { await Sandbox.kill(sandboxId, await options(ownerId)) },
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

/**
 * One task, one sandbox (Alex, 2026-11-01: 「任务跟沙箱机器应该是强绑定。不能一个任务用完之后，
 * 另外一个任务接着去用，这是不允许的。」). A new run of a task takes over the task's
 * own paused sandbox: same owner, workspace, task and repository, and the run
 * that left it has ended. The machine belongs to the task, not to a bot: a
 * follow-up the person sends to another bot on the same task still gets it. The old row ends without a kill and gives up the
 * sandbox; the new row resumes it, so the worktree, the agent's sessions and
 * the worker survive. No other task's machine can match. Caller holds BEGIN
 * and the new run's lock.
 */
async function adoptTaskMachine(client: PoolClient, actor: Actor, runId: string, run: { issueId: string; runtimeBotId: string; repoPath: string; remoteUrl: string | null }) {
  // The run's bot runtime is recorded on the new row; the old row's bot does not have to match.
  const previous = (await client.query(`SELECT m.* FROM thread_machines m
      JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
      JOIN device_repos repo ON repo.id=m."repoId" AND repo."userId"=m."ownerId"
    WHERE m."ownerId"=$1 AND m."workspaceId"=$2 AND m."issueId"=$3 AND m."runId"<>$4
      AND m.state='paused' AND m."sandboxId" IS NOT NULL AND m."deviceId" IS NOT NULL
      AND r.status IN ('succeeded','failed','stopped','cancelled')
      AND repo."repoPath"=$5 AND repo."remoteUrl" IS NOT DISTINCT FROM $6
    ORDER BY m."lastActiveAt" DESC LIMIT 1 FOR UPDATE OF m`, [actor.userId, actor.workspaceId, run.issueId, runId, run.repoPath, run.remoteUrl])).rows[0]
  if (!previous) return null
  await client.query(`UPDATE thread_machines SET state='ended',"endedAt"=COALESCE("endedAt",now()),"sandboxId"=NULL WHERE "runId"=$1`, [previous.runId])
  return (await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","snapshotId","operationId",state,"sandboxId","deviceId","repoId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,'paused',$8,$9,$10)
    ON CONFLICT ("runId") DO UPDATE SET "issueId"=EXCLUDED."issueId","snapshotId"=EXCLUDED."snapshotId",state='paused',"sandboxId"=EXCLUDED."sandboxId","deviceId"=EXCLUDED."deviceId","repoId"=EXCLUDED."repoId"
    RETURNING *`, [runId, actor.workspaceId, actor.userId, run.runtimeBotId, run.issueId, previous.snapshotId, randomUUID(), previous.sandboxId, previous.deviceId, previous.repoId])).rows[0]
}

/**
 * A finished run of an open task keeps its sandbox for the task's next run:
 * paused, which E2B neither bills nor expires (docs.e2b.dev/faq/calculate-sandbox-price:
 * "Paused and killed sandboxes are not billed."; docs.e2b.dev/sandbox/persistence:
 * "A paused sandbox is kept indefinitely."). Its worker's tokens are revoked;
 * a resume mints new ones. A refused pause (503, the sandbox keeps running)
 * throws, and the lifecycle tries again on its next tick.
 */
export async function parkThreadMachine(pool: Pool, actor: Actor, runId: string,
  pause: (sandboxId: string) => Promise<unknown> = sandboxId => withE2BErrors(actor.userId, false, async () => Sandbox.pause(sandboxId, await options(actor.userId))),
  readTail: (sandboxId: string) => Promise<string | null> = sandboxId => readWorkerTail(() => connectComputer(actor.workspaceId, sandboxId))) {
  const machine = (await pool.query(`SELECT "sandboxId","deviceId",state FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3`, [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!machine?.sandboxId || machine.state === 'ended' || machine.state === 'paused') return
  // What the run's worker printed, kept with the machine before it sleeps. Best effort.
  await saveWorkerTail(pool, runId, await readTail(machine.sandboxId), await workspaceSecretMasker(actor.workspaceId)).catch(() => undefined)
  await pause(machine.sandboxId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`UPDATE thread_machines SET state='paused',"lastActiveAt"=now(),"computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL
      WHERE "runId"=$1 AND "sandboxId"=$2 AND state<>'ended'`, [runId, machine.sandboxId])
    await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1', [machine.deviceId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** The worker's last output, saved before a kill; never throws, never waits past readWorkerTail's timeout. */
export async function keepTailBeforeKill(pool: Pick<Pool, 'query'>, actor: Actor, runId: string, sandboxId: string, readTail: (sandboxId: string) => Promise<string | null> = id => readWorkerTail(() => connectComputer(actor.workspaceId, id))) {
  try { await saveWorkerTail(pool, runId, await readTail(sandboxId), await workspaceSecretMasker(actor.workspaceId)) } catch { /* the kill goes ahead */ }
}

/** Closed, duplicate or deleted tasks give up their paused sandboxes for good (kill, device retired). */
export async function endClosedTaskMachines(pool: Pool, end: (actor: Actor, runId: string) => Promise<unknown> = (actor, runId) => threadMachineAction(pool, actor, runId, 'end')) {
  const { rows } = await pool.query(`SELECT m."runId",m."ownerId",m."workspaceId" FROM thread_machines m
    LEFT JOIN issues i ON i.id=m."issueId"
    WHERE m.state='paused' AND m."issueId" IS NOT NULL
      AND (i.id IS NULL OR i.status IN ('done','canceled','duplicate') OR i.content->'attrs'->'mikka'->>'deletedAt' IS NOT NULL)
    LIMIT 50`)
  let ended = 0
  for (const row of rows) {
    try { await end({ userId: row.ownerId, workspaceId: row.workspaceId }, row.runId); ended++ } catch { /* retried on the next sweep */ }
  }
  return { ended, pending: rows.length - ended }
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
    const run = (await client.query(`SELECT r.*,COALESCE(r."agentDefinition"->>'harness',agent.harness) AS "runHarness",b."workspaceId",b."botId" AS "runtimeBotId",repo."repoPath",repo."remoteUrl",repo."baseBranch",repo."verifyCommand",COALESCE(source_repo."repoPath",repo."repoPath") AS "snapshotRepoPath",m."sandboxId" AS "botSandboxId"
      FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      LEFT JOIN agents agent ON agent.id=r."agentId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
      LEFT JOIN bot_cloud_runtimes runtime ON runtime."botId"=b."botId" AND runtime."ownerId"=b."ownerId" AND runtime."workspaceId"=b."workspaceId" AND runtime."agentId"=r."agentId"
      LEFT JOIN device_repos source_repo ON source_repo.id=runtime."repoId" AND source_repo."userId"=r."userId"
      WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 FOR UPDATE OF r`, [runId, actor.userId, actor.workspaceId])).rows[0]
    if (!run || !run.botSandboxId || !['queued', 'preparing', 'running', 'waiting_input'].includes(run.status)) throw new ComputerError(404, 'Thread unavailable')
    const repositoryTask = Boolean(run.remoteUrl)
    // Stop check 1, before any provider call, under the run lock stopOwnedRun also takes.
    if (run.status === 'queued' && run.stopRequestedAt) {
      const stale = await endStopRequestedRun(client, actor, runId)
      await afterRunEnded(actor.userId, runId)
      if (stale) await provider.kill(stale, actor.userId)
      throw new ComputerError(409, 'Thread stopped')
    }
    if (repositoryTask && !repositoryBindingMatches(run.repoPath, run.remoteUrl)) throw new ComputerError(409, 'Repository identity unavailable')
    let machine = (await client.query('SELECT * FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [runId])).rows[0]
    if (machine?.state === 'ended') throw new ComputerError(409, 'Thread ended')
    if (machine?.state === 'running' && machine.sandboxId) {
      const base = await options(actor.userId)
      const state = await withE2BErrors(actor.userId, false, () => Sandbox.getInfo(machine.sandboxId, base)).catch((error: unknown) => {
        if (sandboxGone(error)) return null
        throw error
      })
      if (!state) machine = await replaceGoneSandbox(client, runId)
      else if (state.state !== 'paused') { await client.query('COMMIT'); return { runId, state: 'running' } }
    }
    if (machine?.state === 'running' && machine.sandboxId) {
      // The provider paused this sandbox on its own timeout. E2B stops billing
      // at pause, so persist the end of the running interval before resuming.
      await client.query(`UPDATE thread_machines SET "computeSeconds"="computeSeconds"+GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,"runningSince"=NULL,state='paused' WHERE "runId"=$1 AND "runningSince" IS NOT NULL`, [runId])
      machine.state = 'paused'
    }
    if (machine?.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now() && machine.state !== 'paused') throw new ComputerError(409, 'Thread provisioning in progress')
    // No Mikka caps: the person's own E2B account sets the limit (orchestration.md § 5).
    if (!machine || machine.snapshotId === 'pending') {
      // A follow-up keeps this task's own machine. A new repository task starts
      // from the anonymous ready template of its harness (E2B's claude or codex
      // with Mikka's worker, decision 2026-11-01-2335): the daemon clones its admitted
      // remote and creates the task worktree from the configured base branch.
      // Only non-repository computer work retains the existing desktop snapshot.
      const adopted = run.issueId ? await adoptTaskMachine(client, actor, runId, run) : null
      if (adopted) machine = adopted
      else {
        const snapshotId = repositoryTask ? taskTemplate(run.runHarness) : await provider.snapshot(client, actor, run.botSandboxId, run.snapshotRepoPath)
        machine = (await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","snapshotId","operationId",state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'starting') ON CONFLICT ("runId") DO UPDATE SET "snapshotId"=EXCLUDED."snapshotId","issueId"=EXCLUDED."issueId" RETURNING *`, [runId, actor.workspaceId, actor.userId, run.runtimeBotId, run.issueId ?? null, snapshotId, randomUUID()])).rows[0]
      }
    }
    // Persist snapshot and operation ID before provider requests.
    await client.query('UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval \'15 minutes\' WHERE "runId"=$1', [runId, leaseId])
    await client.query('COMMIT')
    let connected = machine.sandboxId ? await provider.connect(machine.sandboxId, actor.workspaceId).catch((error: unknown) => {
      if (sandboxGone(error)) return null
      throw error
    }) : null
    if (machine.sandboxId && !connected) {
      // The paused sandbox is gone at the provider: the same thread starts a new one from the workspace snapshot.
      machine = await replaceGoneSandbox(pool, runId, leaseId)
      if (!machine) throw new ComputerError(409, 'Thread provisioning cancelled')
    }
    const sandbox = connected ?? await provider.create(machine.snapshotId, machine.operationId, { application: 'mikka-thread', workspaceId: actor.workspaceId, runId }, actor.userId)
    connected = null
    const recorded = await recordThreadSandbox(pool, runId, sandbox.sandboxId, leaseId)
    if (!recorded) {
      // An end can win while Sandbox.create is in flight. The just-created
      // sandbox is not in the row end observed, so this worker must clean it up.
      if (!machine.sandboxId) {
        // Record it even after end so a failed kill remains retryable. A newer
        // lease may share the idempotent sandbox and must not have it killed.
        if (await recordCancelledSandbox(pool, runId, sandbox.sandboxId, machine.operationId)) await provider.kill(sandbox.sandboxId, actor.userId)
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
      if (stale) await provider.kill(stale, actor.userId)
      throw new ComputerError(409, 'Thread stopped')
    }
    await client.query('COMMIT')
    if (!machine.sandboxId && !repositoryTask) {
      // Filesystem snapshots start no old worker process. Remove copied device
      // identity/capabilities before a new worker can make any network call.
      // A snapshot never holds a credential; scrub the same list again in case an older snapshot did.
      await sandbox.commands.run(`rm -rf /home/user/.mikka/worker /home/user/.mikka/bootstrap.json /run/mikka-viewer /run/mikka-subagents; ${credentialScrubCommand()}; install -d -m 700 /run/mikka-viewer`, { user: 'root', timeoutMs: 10_000 })
    }
    const deviceId = machine.deviceId ?? randomUUID()
    const repoId = machine.repoId ?? randomUUID()
    const credential = `orv_${randomBytes(32).toString('base64url')}`
    const origin = new URL(process.env.MIKKA_CLOUD_WORKER_URL ?? '')
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('Worker unavailable')
    const expectedSha = process.env.MIKKA_CLOUD_WORKER_SHA
    // Version verification and viewer startup are independent. Hosted runs no
    // longer use Docker; never pull its obsolete image on the critical path.
    // A repository task's machine (claude or codex template) has no desktop.
    const [sourceSha] = await Promise.all([
      sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' }).then(value => value.trim()),
      repositoryTask ? undefined : installComputerRuntime(sandbox),
    ])
    if (!expectedSha || sourceSha !== expectedSha) throw new Error('Worker version mismatch')
    await client.query('BEGIN')
    // Provision, end and desktop all lock the parent run before its machine.
    const current = (await client.query('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])).rows[0]
    const activeLease = await client.query('SELECT 1 FROM thread_machines WHERE "runId"=$1 AND "workerLeaseId"=$2 AND state<>\'ended\' FOR UPDATE', [runId, leaseId])
    if (!activeLease.rowCount) throw new ComputerError(409, 'Thread provisioning cancelled')
    const definition = current.agentDefinition
    const admission = definition?.repositoryAdmission
    if (current.status === 'queued' && admission) {
      if (!matchesRepositoryAdmission(admission, {
        userId: actor.userId, issueId: current.issueId, deviceId: current.deviceId, agentId: current.agentId,
        remoteKey: run.repoPath, remoteUrl: run.remoteUrl, targetBranch: admission.targetBranch,
        ...(current.botId ? { workspaceId: actor.workspaceId } : {}),
        workspaceLinked: admission.workspaceLinked, requestEventId: admission.requestEventId,
      })) throw new ComputerError(409, 'Repository authority unavailable')
      // Host-owned relocation changes the executor, never the admitted repository or branch.
      definition.repositoryAdmission = { ...admission, deviceId }
    }
    // The sandbox's hostname (e2b.local) never renames it; a re-provisioned machine is live again.
    await client.query('INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES ($1,$2,$3,\'cloud\',true) ON CONFLICT(id) DO UPDATE SET "removedAt"=NULL', [deviceId, actor.userId, 'Thread computer'])
    await client.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch","verifyCommand","remoteUrl") VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', [repoId, deviceId, actor.userId, run.repoPath, run.baseBranch, run.verifyCommand,run.remoteUrl])
    await client.query('UPDATE thread_machines SET "deviceId"=$2,"repoId"=$3 WHERE "runId"=$1', [runId, deviceId, repoId])
    await client.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1', [deviceId])
    await client.query('INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval \'24 hours\')', [randomUUID(), actor.userId, 'Thread worker', createHash('sha256').update(credential).digest('hex'), deviceId, actor.workspaceId])
    await client.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"=COALESCE($5::jsonb,"agentDefinition") WHERE id=$1 AND "userId"=$4 AND status=\'queued\'', [runId, deviceId, repoId, actor.userId, admission ? JSON.stringify(definition) : null])
    await client.query('COMMIT')
    const handoff = `/run/mikka-viewer/thread-${leaseId}.json`
    await sandbox.files.write(handoff, JSON.stringify({ deviceId, workspaceId: actor.workspaceId, credential, server: origin.toString(), ...(process.env.VERCEL_ENV === 'preview' && process.env.MIKKA_CLOUD_PREVIEW_BYPASS ? { protectionBypass: process.env.MIKKA_CLOUD_PREVIEW_BYPASS } : {}) }), { user: 'root' })
    await sandbox.commands.run(`install -d -o user -g user -m 700 /home/user/.mikka; install -o user -g user -m 600 ${handoff} /home/user/.mikka/bootstrap.next; mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json; unlink ${handoff}`, { user: 'root', timeoutMs: 10_000 })
    // The worker's output streams into the server logs only while this invocation lives;
    // the tee'd file in the sandbox keeps it for later reads (park, failure, end).
    const mask = await workspaceSecretMasker(actor.workspaceId)
    await sandbox.commands.run(workerCommand(CLOUD_WORKER_COMMAND), { user: 'user', background: true, timeoutMs: 0, ...workerOutputForwarder(runId, mask) })
    const deadline = Date.now() + 30_000
    let ready = false
    do {
      ready = Boolean((await pool.query('SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND "lastSeenAt">now()-interval \'30 seconds\'', [deviceId, actor.userId])).rowCount)
      if (!ready) await new Promise(resolve => setTimeout(resolve, 500))
    } while (!ready && Date.now() < deadline)
    if (!ready) {
      // Say what the worker printed: the run's error and the machine keep its last lines.
      await saveWorkerTail(pool, runId, await readWorkerTail(async () => sandbox), mask, 'Thread worker did not register').catch(() => undefined)
      throw new Error('Thread worker did not register')
    }
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
    const sandbox = await runtime.connectComputer(actor.workspaceId, machine.sandboxId)
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
      // An ended machine's device is gone for good: no list shows it, nothing dispatches to it.
      await client.query('UPDATE devices SET "removedAt"=COALESCE("removedAt",now()) WHERE id=$1 AND "ownerId"=$2 AND kind=\'cloud\'', [locked.deviceId, actor.userId])
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
    // A running machine's last output is kept before the kill (a parked one kept it when it paused).
    // Best effort and bounded: reading never blocks the kill.
    if (sandboxId && machine.state !== 'paused') await keepTailBeforeKill(pool, actor, runId, sandboxId)
    if (sandboxId) await Sandbox.kill(sandboxId, await options(actor.userId))
    return { runId, state: 'ended' }
  }
  if (action === 'resume') return ensureThreadMachine(pool, actor, runId)
  if (action === 'desktop') return openThreadDesktop(pool, actor, runId)
  if (!machine.sandboxId) throw new ComputerError(409, 'Thread machine has not started')
  const sandbox = await connectComputer(actor.workspaceId, machine.sandboxId)
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
