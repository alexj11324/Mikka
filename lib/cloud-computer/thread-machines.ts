import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { Sandbox } from 'e2b'
import { z } from 'zod'
import { ComputerError } from '@/lib/computer/store'
import { connectComputer, installComputerRuntime, startDesktop, syncDesktopLease, ensureHostedRunnerImage } from '@/lib/computer/e2b-provider'
import { installSubagentRuntime, runtimeRequest } from './runtime'
import type { Actor } from './subagents'
const options = () => ({ apiKey: process.env.E2B_API_KEY!, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
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
/** The queued run is moved to a dedicated device before any worker can claim
 * it. Bot workers are denied these runs by claimCloudRun. */
export async function ensureThreadMachine(pool: Pool, actor: Actor, runId: string) {
  z.uuid().parse(runId)
  const client = await pool.connect()
  const leaseId = randomUUID()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-machine:${runId}`])
    const run = (await client.query(`SELECT r.*,b."workspaceId",repo."repoPath",repo."baseBranch",repo."verifyCommand",m."sandboxId" AS "botSandboxId"
      FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
      WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 FOR UPDATE OF r`, [runId, actor.userId, actor.workspaceId])).rows[0]
    if (!run || !run.botSandboxId || !['queued', 'preparing', 'running', 'waiting_input'].includes(run.status)) throw new ComputerError(404, 'Thread unavailable')
    let machine = (await client.query('SELECT * FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [runId])).rows[0]
    if (machine?.state === 'ended') throw new ComputerError(409, 'Thread ended')
    if (machine?.state === 'running') { await client.query('COMMIT'); return { runId, state: 'running' } }
    if (machine?.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now() && machine.state !== 'paused') throw new ComputerError(409, 'Thread provisioning in progress')
    if (!machine) {
      const source = await connectComputer(run.botSandboxId)
      const snapshotId = await workspaceSnapshot(client as unknown as Pool, actor, source, run.repoPath)
      machine = (await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state)
        VALUES ($1,$2,$3,$4,$5,$6,'starting') RETURNING *`, [runId, actor.workspaceId, actor.userId, run.botId, snapshotId, randomUUID()])).rows[0]
    }
    // Persist snapshot and operation ID before provider requests.
    await client.query('UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval \'15 minutes\' WHERE "runId"=$1', [runId, leaseId])
    await client.query('COMMIT')
    const sandbox = machine.sandboxId ? await connectComputer(machine.sandboxId) : await Sandbox.create(machine.snapshotId, { ...options(), idempotencyKey: machine.operationId, timeoutMs: 15 * 60_000, metadata: { application: 'mikka-thread', workspaceId: actor.workspaceId, runId }, lifecycle: { onTimeout: 'pause', autoResume: false } })
    await pool.query('UPDATE thread_machines SET "sandboxId"=$2 WHERE "runId"=$1 AND "workerLeaseId"=$3', [runId, sandbox.sandboxId, leaseId])
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
    await client.query('SELECT 1 FROM thread_machines WHERE "runId"=$1 AND "workerLeaseId"=$2 FOR UPDATE', [runId, leaseId])
    await client.query('INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,$3,\'cloud\') ON CONFLICT(id) DO NOTHING', [deviceId, actor.userId, 'Thread computer'])
    await client.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch","verifyCommand") VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING', [repoId, deviceId, actor.userId, run.repoPath, run.baseBranch, run.verifyCommand])
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
    await pool.query('UPDATE thread_machines SET state=\'running\',"lastActiveAt"=now(),"workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND "workerLeaseId"=$2', [runId, leaseId])
    return { runId, state: 'running' }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
export async function threadMachineAction(pool: Pool, actor: Actor, runId: string, action: 'pause' | 'resume' | 'end' | 'desktop') {
  const machine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!machine?.sandboxId || machine.state === 'ended') throw new ComputerError(404, 'Thread unavailable')
  if (action === 'resume') return ensureThreadMachine(pool, actor, runId)
  const sandbox = await connectComputer(machine.sandboxId)
  if (action === 'pause') { await sandbox.pause(); await pool.query('UPDATE thread_machines SET state=\'paused\' WHERE "runId"=$1', [runId]) }
  if (action === 'end') { await sandbox.kill(); await pool.query('UPDATE thread_machines SET state=\'ended\',"endedAt"=now() WHERE "runId"=$1', [runId]); await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1', [machine.deviceId]) }
  if (action === 'desktop') {
    await startDesktop(sandbox, 1)
    await syncDesktopLease(sandbox, { botId: machine.botId, ownerId: actor.userId, display: 1, epoch: machine.epoch, controlledBy: null, controlUntil: 0, computerAllowed: true, policyVersion: 0 })
    await installSubagentRuntime(sandbox, actor.userId)
    const browser = await runtimeRequest(machine.sandboxId, { id: runId, ownerId: actor.userId, workspaceId: actor.workspaceId, botId: machine.botId, epoch: machine.epoch }, '/start', {})
    await pool.query('UPDATE thread_machines SET "targetId"=$2 WHERE "runId"=$1', [runId, browser.targetId])
  }
  return { runId, state: action === 'end' ? 'ended' : action === 'pause' ? 'paused' : machine.state }
}
