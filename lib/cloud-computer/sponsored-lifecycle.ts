import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { assertRunProjectResources } from '../project-resources/run-lease'
import { rebindExecutionDevice, revalidateExecutionIdentity } from '../execution-identity'
import { matchesRepositoryAdmission } from '../repository-admission'
import { ComputerError } from '../computer/store'
import { runChanged } from '../live/panels'
import { openOwnedCloudflareTaskMachine, releaseOwnedCloudflareTaskMachine } from '../eve/cloudflare-task-bridge'
import { finishThreadRegistration, prepareThreadRegistration } from './thread-registration'
import { hostedSnapshot, type TaskMachineActor } from './sponsored-task'

const unavailable = () => new ComputerError(409, 'Cloudflare task machine unavailable')
const fixedWorker =
  'exec /usr/local/bin/node /opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js --cloudflare-task'

type Handoff = {
  deviceId: string
  operationId: string
  leaseId: string
  registrationAt: Date
  tokenHash: string
  bootstrap: string
}

async function reserve(tx: PoolClient, actor: TaskMachineActor, runId: string): Promise<Handoff | null> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['thread-machine:' + runId])
  const parent = (
    await tx.query(`SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3`, [
      runId,
      actor.userId,
      actor.workspaceId,
    ])
  ).rows[0]
  if (!parent?.issueId) throw unavailable()
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'thread-task-machine:' + actor.userId + ':' + actor.workspaceId + ':' + parent.issueId,
  ])
  const run = (
    await tx.query(
      `SELECT r.*,repo."repoPath",repo."remoteUrl",repo."verifyCommand" FROM agent_runs r
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId" AND b."botId"=r."botId" AND b."workspaceId"=r."workspaceId"
    JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3 AND r."issueId"=$4 FOR UPDATE OF r FOR SHARE OF b,repo`,
      [runId, actor.userId, actor.workspaceId, parent.issueId],
    )
  ).rows[0]
  const machine = (
    await tx.query(
      `SELECT * FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3
      AND "issueId"=$4 AND "snapshotId"=$5 FOR UPDATE`,
      [runId, actor.userId, actor.workspaceId, parent.issueId, hostedSnapshot],
    )
  ).rows[0]
  if (
    !run ||
    !machine ||
    machine.state === 'ended' ||
    run.stopRequestedAt ||
    !run.agentDefinition?.taskMachine ||
    run.agentDefinition.taskMachine.repositoryKey !== run.repoPath ||
    run.agentDefinition.taskMachine.taskId !== run.issueId
  )
    throw unavailable()
  await assertRunProjectResources(tx, run)
  await revalidateExecutionIdentity(tx, run)
  if (
    machine.state === 'running' &&
    machine.sandboxId &&
    new Date(machine.lifecycle.sponsoredUntil).getTime() > Date.now()
  )
    return null
  if (
    run.status !== 'queued' ||
    run.startedAt ||
    run.sessionId ||
    run.deviceTokenId ||
    run.questionContinuation?.requireSessionResume ||
    (machine.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now())
  )
    throw unavailable()
  const origin = new URL(process.env.MIKKA_CLOUD_WORKER_URL ?? '')
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash)
    throw unavailable()
  if (machine.lifecycle.sponsoredUntil) await releaseOwnedCloudflareTaskMachine(tx, actor, runId, machine.operationId)
  const leaseId = randomUUID(),
    operationId = randomUUID(),
    deviceId = machine.deviceId ?? randomUUID(),
    repoId = machine.repoId ?? randomUUID()
  const credential = 'orv_' + randomBytes(32).toString('base64url'),
    tokenHash = createHash('sha256').update(credential).digest('hex'),
    tokenId = randomUUID()
  const definition = structuredClone(run.agentDefinition)
  if (definition.repositoryAdmission) {
    const a = definition.repositoryAdmission
    if (
      (a.workspaceId != null && a.workspaceId !== actor.workspaceId) ||
      !matchesRepositoryAdmission(a, {
        userId: actor.userId,
        issueId: run.issueId,
        deviceId: run.deviceId,
        agentId: run.agentId,
        remoteKey: run.repoPath,
        remoteUrl: run.remoteUrl,
        targetBranch: a.targetBranch,
        workspaceId: a.workspaceId,
        workspaceLinked: a.workspaceLinked,
        requestEventId: a.requestEventId,
      })
    )
      throw unavailable()
    definition.repositoryAdmission = { ...a, deviceId }
  }
  const issued = await prepareThreadRegistration(tx, {
    runId,
    deviceId,
    repoId,
    ownerId: actor.userId,
    workspaceId: actor.workspaceId,
    repoPath: run.repoPath,
    remoteUrl: run.remoteUrl,
    baseBranch: run.baseBranch,
    verifyCommand: run.verifyCommand,
    tokenId,
    tokenSha256: tokenHash,
  })
  const moved = await rebindExecutionDevice(tx, { ...run, agentDefinition: definition }, deviceId)
  await tx.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"=$4 WHERE id=$1', [
    runId,
    deviceId,
    repoId,
    moved,
  ])
  await tx.query(
    `UPDATE thread_machines SET state='starting',epoch=epoch+1,"sandboxId"=NULL,"operationId"=$2,"workerLeaseId"=$3,
    "workerLeaseUntil"=clock_timestamp()+interval '90 seconds',"lifecycleAt"=clock_timestamp()+interval '90 seconds',
    lifecycle=lifecycle||jsonb_build_object('phase','create_requested','sponsoredUntil',clock_timestamp()+interval '15 minutes') WHERE "runId"=$1`,
    [runId, operationId, leaseId],
  )
  await tx.query(`UPDATE device_tokens SET "expiresAt"=clock_timestamp()+interval '15 minutes' WHERE id=$1`, [tokenId])
  return {
    deviceId,
    operationId,
    leaseId,
    registrationAt: issued.now,
    tokenHash,
    bootstrap: JSON.stringify({ deviceId, workspaceId: actor.workspaceId, credential, server: origin.toString() }),
  }
}

// A stdout frame is only a readiness notification. The final transaction below
// additionally requires the very same token and device to have authenticated.
async function waitForRegistration(stdout: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stdout.getReader(),
    decoder = new TextDecoder()
  let buffered = ''
  const cancel = () => {
    void reader.cancel()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) throw unavailable()
      buffered += decoder.decode(value, { stream: true })
      if (buffered.split('\n').includes('mikka-task-worker-registered')) return
      if (buffered.length > 4096) throw unavailable()
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

export async function ensureSponsoredTaskMachine(pool: Pool, actor: TaskMachineActor, runId: string) {
  const reservation = await pool.connect()
  let handoff: Handoff | null
  try {
    await reservation.query('BEGIN')
    handoff = await reserve(reservation, actor, runId)
    await reservation.query('COMMIT')
  } catch (error) {
    await reservation.query('ROLLBACK')
    throw error
  } finally {
    reservation.release()
  }
  if (!handoff) {
    await (await import('../eve/cloudflare-task-bridge')).confirmOwnedTaskMachine(pool, actor, runId)
    return { runId, state: 'running' }
  }
  try {
    const { connection, instanceId } = await openOwnedCloudflareTaskMachine(pool, actor, runId)
    const changed = await pool.query(
      `UPDATE thread_machines SET "sandboxId"=$2,"runningSince"=clock_timestamp()
      WHERE "runId"=$1 AND "operationId"=$3 AND "workerLeaseId"=$4 AND state='starting'`,
      [runId, instanceId, handoff.operationId, handoff.leaseId],
    )
    if (!changed.rowCount) throw unavailable()
    const signal = AbortSignal.timeout(60_000)
    const proc = await connection.spawn({ command: fixedWorker, workingDirectory: '/workspace', stdin: true })
    if (!proc.stdin) throw unavailable()
    const drain = new WritableStream<Uint8Array>({ write() {} })
    void proc.stderr.pipeTo(drain).catch(() => {})
    const writer = proc.stdin.getWriter()
    await writer.write(new TextEncoder().encode(JSON.stringify({ runId, bootstrap: handoff.bootstrap })))
    await writer.close()
    await waitForRegistration(proc.stdout, signal)
    void proc.stdout.pipeTo(new WritableStream({ write() {} })).catch(() => {})
    const registration = await pool.connect()
    try {
      const result = await finishThreadRegistration(
        registration,
        runId,
        handoff.leaseId,
        handoff.deviceId,
        handoff.tokenHash,
        handoff.registrationAt,
      )
      if (!result.rowCount) throw unavailable()
    } finally {
      registration.release()
    }
    await runChanged(pool, runId)
    return { runId, state: 'running' }
  } catch (error) {
    // Revoke before any external release. A lost response leaves the same
    // operation eligible for its durable DO alarm and existing recovery timer.
    await pool.query(`UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "tokenHash"=$1`, [
      handoff.tokenHash,
    ])
    await releaseOwnedCloudflareTaskMachine(pool, actor, runId, handoff.operationId).catch(() => {})
    await pool.query(
      `UPDATE thread_machines SET state='error',"workerLeaseId"=NULL,"workerLeaseUntil"=NULL,"lifecycleAt"=now()
      WHERE "runId"=$1 AND "operationId"=$2 AND state<>'ended'`,
      [runId, handoff.operationId],
    )
    throw error
  }
}

type Reconciliation = {
  epoch: number
  sandboxId: string | null
  operationId?: string
  state: string
  status: string
  stopRequestedAt: unknown
  lifecycle: Record<string, unknown>
  taskClosed: boolean
}

export async function reconcileSponsoredTaskMachine(
  pool: Pool,
  actor: TaskMachineActor,
  runId: string,
  row: Reconciliation,
  now: number,
): Promise<false | number> {
  const fence = { epoch: row.epoch, sandboxId: row.sandboxId }
  const terminal = ['succeeded', 'failed', 'stopped', 'cancelled'].includes(row.status)
  const deadline = typeof row.lifecycle.sponsoredUntil === 'string' ? Date.parse(row.lifecycle.sponsoredUntil) : NaN
  const expired = Number.isFinite(deadline) && deadline <= now
  if (row.stopRequestedAt || row.taskClosed || (expired && !terminal && row.state !== 'paused')) {
    const { threadMachineAction } = await import('./thread-machines')
    await threadMachineAction(pool, actor, runId, 'end', fence)
    return false
  }
  if (terminal || ['error', 'ended', 'paused'].includes(row.state)) {
    if (row.operationId && Number.isFinite(deadline))
      await releaseOwnedCloudflareTaskMachine(pool, actor, runId, row.operationId)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const done = await client.query(
        `UPDATE thread_machines SET state=CASE WHEN state='ended' THEN state WHEN $6 THEN 'paused' ELSE state END,
        "computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),
        "runningSince"=NULL,"sandboxId"=NULL,"workerLeaseId"=NULL,"workerLeaseUntil"=NULL,"lifecycleAt"=NULL
        WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND "operationId"=$5 RETURNING "deviceId"`,
        [runId, actor.userId, actor.workspaceId, row.epoch, row.operationId, terminal],
      )
      if (done.rowCount && done.rows[0].deviceId)
        await client.query(
          `UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1`,
          [done.rows[0].deviceId],
        )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return false
  }
  // The DO owns its immutable hard alarm. The existing application timer also
  // wakes on terminal Run transitions, so live jobs need no additional polls.
  await pool.query(
    `UPDATE thread_machines SET "lifecycleAt"=$5 WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4`,
    [runId, actor.userId, actor.workspaceId, row.epoch, Number.isFinite(deadline) ? new Date(deadline) : null],
  )
  return Number.isFinite(deadline) ? deadline : false
}
