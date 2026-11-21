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
import { PaidResourceError } from '../abuse/policy'
import { DEFAULT_MACHINE_SIZE, isMachineSize, MACHINE_CHUNK_MS, MACHINE_GRACE_MS, MACHINE_RENEW_BEFORE_MS, type MachineSize } from './machine-pricing'

const unavailable = () => new ComputerError(409, 'Cloudflare task machine unavailable')
const fixedWorker =
  'exec /usr/local/bin/node /opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js --cloudflare-task'

type Handoff = {
  /** The size the machine is billed at (decision 2026-11-15-1900): the run's own, else Mikka's default. */
  size: MachineSize
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
    await tx.query(`SELECT "issueId","questionContinuation",status,"startedAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3`, [
      runId,
      actor.userId,
      actor.workspaceId,
    ])
  ).rows[0]
  if (!parent?.issueId) throw unavailable()
  // The established answer/recovery receipt locks the Factory task before the
  // Run or machine. A Run's claimed native session ID alone cannot authorize a wake.
  const wakingQuestion = parent.questionContinuation?.requireSessionResume && parent.status === 'queued' && !parent.startedAt
  if (wakingQuestion) {
    const { lockQuestionRuntimeUpgrade } = await import('./thread-machines')
    await lockQuestionRuntimeUpgrade(tx, actor, runId, parent.questionContinuation.questionId)
  }
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
    (machine.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now())
  )
    throw unavailable()
  const origin = new URL(process.env.MIKKA_CLOUD_WORKER_URL ?? '')
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash)
    throw unavailable()
  let requiredCheckpoint = machine.lifecycle.sponsoredRestore
  if (run.questionContinuation?.requireSessionResume) {
    const expected = run.questionContinuation.requiredSandboxId
    if (!wakingQuestion || !/^[0-9a-f]{64}$/.test(expected) || expected !== machine.lifecycle.sponsoredInstanceId ||
        machine.deviceId !== run.deviceId || machine.repoId !== run.deviceRepoId ||
        machine.lifecycle.sponsoredPreviousRun !== (run.continuesRunId ?? run.questionContinuation.originRunId) ||
        !machine.lifecycle.sponsoredPreviousOperation) throw unavailable()
    if (!requiredCheckpoint) requiredCheckpoint = await releaseOwnedCloudflareTaskMachine(tx, actor,
      machine.lifecycle.sponsoredPreviousRun, machine.lifecycle.sponsoredPreviousOperation)
    if (!requiredCheckpoint || requiredCheckpoint.instanceId !== expected) throw unavailable()
  }
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
  const frozenSize = run.agentDefinition.taskMachine.size
  const size: MachineSize = isMachineSize(frozenSize) ? frozenSize : DEFAULT_MACHINE_SIZE
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
    lifecycle=lifecycle||jsonb_build_object('phase','create_requested','sponsoredUntil',clock_timestamp()+make_interval(secs=>$6::double precision/1000),
      'sponsoredRepositoryKey',$4::text,'sponsoredChunks',1,'sponsoredSize',$7::text) || CASE WHEN $5::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sponsoredRestore',$5::jsonb) END WHERE "runId"=$1`,
    [runId, operationId, leaseId, run.repoPath, requiredCheckpoint ? JSON.stringify(requiredCheckpoint) : null, MACHINE_CHUNK_MS, size],
  )
  await tx.query(`UPDATE device_tokens SET "expiresAt"=clock_timestamp()+interval '15 minutes' WHERE id=$1`, [tokenId])
  return {
    size,
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
    // Machine time is paid from Mikka 额度 before the machine opens (decision 2026-11-15-1900).
    const { fundMachineChunk } = await import('./machine-billing')
    if (!await fundMachineChunk({ ownerId: actor.userId, workspaceId: actor.workspaceId, runId, operationId: handoff.operationId, index: 0, size: handoff.size }))
      throw new PaidResourceError('points_exhausted')
    const { connection, instanceId } = await openOwnedCloudflareTaskMachine(pool, actor, runId)
    const changed = await pool.query(
      `UPDATE thread_machines SET "sandboxId"=$2,"runningSince"=clock_timestamp(),
        lifecycle=lifecycle||jsonb_build_object('sponsoredInstanceId',$2::text)
      WHERE "runId"=$1 AND "operationId"=$3 AND "workerLeaseId"=$4 AND state='starting'`,
      [runId, instanceId, handoff.operationId, handoff.leaseId],
    )
    if (!changed.rowCount) throw unavailable()
    const signal = AbortSignal.timeout(60_000)
    const proc = await connection.spawn({ command: fixedWorker, workingDirectory: '/workspace', env: {}, stdin: true })
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

/** The Factory has authenticated the human answer and will recheck it when it
 * transfers custody. Hosted images are immutable. Prepare that exact failed
 * continuation's checkpoint without starting its VM or issuing credentials. */
export async function prepareSponsoredQuestionRecovery(pool: Pool, actor: TaskMachineActor, runId: string) {
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    const {rows:[m]} = await tx.query(`SELECT m."operationId",m.lifecycle,r."questionContinuation" AS question
      FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId" AND r."workspaceId"=m."workspaceId" AND r."issueId"=m."issueId"
      JOIN factory_questions q ON q."continuationRunId"=r.id AND q."userId"=r."userId" AND q."issueId"=r."issueId"
        AND q.id::text=r."questionContinuation"->>'questionId' AND q."originSessionId"=r."questionContinuation"->>'originSessionId'
      JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=q."issueId"
      WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."snapshotId"=$4
        AND r.status='failed' AND r."stopRequestedAt" IS NULL AND q.status='blocked' AND t.status='blocked'
        AND q."answerId" IS NOT NULL AND r."questionContinuation"->>'requireSessionResume'='true'
      FOR UPDATE OF m FOR SHARE OF r`, [runId,actor.userId,actor.workspaceId,hostedSnapshot])
    if (!m) { await tx.query('COMMIT'); return false }
    const prior = m.lifecycle.sponsoredUntil
      ? {runId, operationId:m.operationId}
      : {runId:m.lifecycle.sponsoredPreviousRun, operationId:m.lifecycle.sponsoredPreviousOperation}
    if (!prior.runId || !prior.operationId) throw unavailable()
    const checkpoint = await releaseOwnedCloudflareTaskMachine(tx,actor,prior.runId,prior.operationId)
    if (!checkpoint || checkpoint.instanceId !== m.question.requiredSandboxId ||
        checkpoint.instanceId !== m.lifecycle.sponsoredInstanceId) throw unavailable()
    await tx.query(`UPDATE thread_machines SET lifecycle=lifecycle||jsonb_build_object('sponsoredPreparedCheckpoint',$3::jsonb)
      WHERE "runId"=$1 AND "operationId"=$2`, [runId,m.operationId,JSON.stringify(checkpoint)])
    await tx.query('COMMIT')
    return true
  } catch (error) {
    await tx.query('ROLLBACK')
    throw error
  } finally { tx.release() }
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
  // A funded machine has a grace period past its paid time: a late renewal
  // wake pays the missed chunks below instead of ending the thread.
  const unfundedNow = row.lifecycle.sponsoredUnfunded === true
  const expired = Number.isFinite(deadline) && deadline + (unfundedNow ? 0 : MACHINE_GRACE_MS) <= now
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
        "runningSince"=NULL,"sandboxId"=CASE WHEN state='ended' THEN NULL ELSE "sandboxId" END,"workerLeaseId"=NULL,"workerLeaseUntil"=NULL,"lifecycleAt"=NULL
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
  // Prepaid machine time: just before the paid chunk ends, pay the next one from
  // Mikka 额度 and extend the lease, or stop the run when nothing can pay.
  let until = deadline, unfunded = row.lifecycle.sponsoredUnfunded === true
  // A late wake pays every missed chunk in order until the paid time is ahead of now again.
  while (Number.isFinite(until) && row.operationId && !unfunded && now >= until - MACHINE_RENEW_BEFORE_MS) {
    const renewed = await renewSponsoredMachine(pool, actor, runId, row, until)
    if (renewed.until === until && !renewed.unfunded) break
    ;({ until, unfunded } = renewed)
    row = { ...row, lifecycle: { ...row.lifecycle, sponsoredUntil: new Date(until).toISOString(), sponsoredChunks: (typeof row.lifecycle.sponsoredChunks === 'number' ? row.lifecycle.sponsoredChunks : 1) + 1 } }
  }
  // Unfunded: wake at the paid deadline to end the machine. Otherwise wake to renew (never sooner than 5 s).
  const wake = !Number.isFinite(until) ? NaN : unfunded ? until : Math.max(now + 5_000, until - MACHINE_RENEW_BEFORE_MS)
  // The DO owns its immutable hard alarm. The existing application timer also
  // wakes on terminal Run transitions, so live jobs need no additional polls.
  await pool.query(
    `UPDATE thread_machines SET "lifecycleAt"=$5 WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4`,
    [runId, actor.userId, actor.workspaceId, row.epoch, Number.isFinite(wake) ? new Date(wake) : null],
  )
  return Number.isFinite(wake) ? wake : false
}

/** Pays the next chunk and extends the lease; returns the (possibly new) paid deadline. */
async function renewSponsoredMachine(pool: Pool, actor: TaskMachineActor, runId: string, row: Reconciliation, deadline: number): Promise<{ until: number; unfunded: boolean }> {
  const size = isMachineSize(row.lifecycle.sponsoredSize) ? row.lifecycle.sponsoredSize : DEFAULT_MACHINE_SIZE
  const index = typeof row.lifecycle.sponsoredChunks === 'number' ? row.lifecycle.sponsoredChunks : 1
  const { fundMachineChunk } = await import('./machine-billing')
  const funded = await fundMachineChunk({ ownerId: actor.userId, workspaceId: actor.workspaceId, runId, operationId: row.operationId!, index, size })
  if (!funded) {
    // Out of Mikka 额度: the run stops at the end of what is paid, with its reason in the thread.
    await pool.query(
      `UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",now()),"stopReason"=COALESCE("stopReason",'cloud_machine_unfunded'),
        error=COALESCE(error,'cloud_machine_unfunded'),"updatedAt"=now()
      WHERE id=$1 AND "userId"=$2 AND status NOT IN ('succeeded','failed','stopped','cancelled')`,
      [runId, actor.userId],
    )
    await pool.query(
      `UPDATE thread_machines SET lifecycle=lifecycle||jsonb_build_object('sponsoredUnfunded',true)
      WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND "operationId"=$5`,
      [runId, actor.userId, actor.workspaceId, row.epoch, row.operationId],
    )
    await runChanged(pool, runId)
    return { until: deadline, unfunded: true }
  }
  const extended = await pool.query<{ until: string }>(
    `UPDATE thread_machines SET lifecycle=lifecycle||jsonb_build_object(
        'sponsoredUntil',((lifecycle->>'sponsoredUntil')::timestamptz+make_interval(secs=>$6::double precision/1000)),
        'sponsoredChunks',$7::int+1)
      WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND "operationId"=$5
        AND COALESCE((lifecycle->>'sponsoredChunks')::int,1)=$7::int
      RETURNING lifecycle->>'sponsoredUntil' AS until`,
    [runId, actor.userId, actor.workspaceId, row.epoch, row.operationId, MACHINE_CHUNK_MS, index],
  )
  const next = extended.rows[0] ? Date.parse(extended.rows[0].until) : deadline
  // The DO lease follows the paid deadline (same grant, later expiry).
  if (extended.rows[0]) await (await import('../eve/cloudflare-task-bridge')).extendOwnedTaskMachine(pool, actor, runId)
  return { until: next, unfunded: false }
}
