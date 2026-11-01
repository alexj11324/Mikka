import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Sandbox } from 'e2b'
import type { Pool } from 'pg'
import { provisionCloudDevice } from './cloud-device'
import { claimWorkerLease, releaseWorkerLease, renewWorkerLease } from './worker-lease'
import * as provider from './e2b-provider'
import { CloudWorkerError } from './worker-error'

type Actor = { userId: string; workspaceId: string }

/** Start or rotate the trusted worker on an existing machine. The database
 * lease serializes handoffs even when Postgres connections are pooled. */
export async function startCloudWorker(pool: Pool, actor: Actor, sandbox: Sandbox, server: string, sourceSha: string, runtime = provider) {
  const url = new URL(server)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid cloud worker configuration')
  const protectionBypass = process.env.VERCEL_ENV === 'preview' ? process.env.MIKKA_CLOUD_PREVIEW_BYPASS : undefined
  if (protectionBypass && (!url.hostname.endsWith('.vercel.app') || !/^[A-Za-z0-9_-]{20,256}$/.test(protectionBypass))) throw new Error('Invalid cloud worker configuration')
  const leaseId = randomUUID()
  if (!await claimWorkerLease(pool, actor, sandbox.sandboxId, leaseId)) throw new Error('Cloud worker provisioning is busy or unavailable')
  const temporary = `/run/mikka-viewer/worker-${leaseId}.next`
  try {
    const pinned = await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' })
    if (pinned.trim() !== sourceSha) throw new CloudWorkerError('worker_version_mismatch', sandbox.sandboxId)
    const existing = await pool.query(`SELECT d.id FROM cloud_machines m JOIN devices d ON d.id=m."deviceId"
      JOIN device_tokens t ON t."boundDeviceId"=d.id AND t."boundWorkspaceId"=m."workspaceId" AND t."userId"=m."ownerId"
      WHERE m."workspaceId"=$1 AND m."ownerId"=$2 AND m."sandboxId"=$3 AND d."ownerId"=$2 AND d.kind='cloud'
        AND d."lastSeenAt">now()-interval '60 seconds' AND t."lastUsedAt">now()-interval '2 minutes'
        AND t."revokedAt" IS NULL AND t."expiresAt">now()+interval '1 hour' LIMIT 1`, [actor.workspaceId, actor.userId, sandbox.sandboxId])
    if (existing.rowCount) return { deviceId: existing.rows[0].id as string }
    await runtime.ensureHostedRunnerImage(sandbox)
    if (!await renewWorkerLease(pool, actor, leaseId)) throw new Error('Cloud worker lease expired')
    const started = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const credential = await provisionCloudDevice(pool, actor, new Date(started.getTime() + 24 * 60 * 60_000), leaseId)
    const hash = createHash('sha256').update(credential.token).digest('hex')
    // The staging directory is root-only; the runner's handoff is private and
    // no credential appears in a shell command, argument or environment.
    await sandbox.files.write(temporary, JSON.stringify({ deviceId: credential.deviceId, workspaceId: actor.workspaceId, credential: credential.token, server: url.toString(), ...(protectionBypass ? { protectionBypass } : {}) }), { user: 'root' })
    if (!await renewWorkerLease(pool, actor, leaseId)) throw new Error('Cloud worker lease expired')
    await sandbox.commands.run(`install -d -o mikka-runner -g mikka-runner -m 0700 /home/mikka-runner/.mikka && install -o mikka-runner -g mikka-runner -m 0600 ${temporary} /home/mikka-runner/.mikka/bootstrap.next && mv /home/mikka-runner/.mikka/bootstrap.next /home/mikka-runner/.mikka/bootstrap.json && unlink ${temporary}`, { user: 'root', timeoutMs: 10_000 })
    // 4e3: the worker process gets no workspace secrets. Each task receives its explicit user
    // variable set in the claim response (taskEnv) and the hosted runner passes only that into the task container.
    await sandbox.commands.run('cd /opt/mikka/worker/packages/daemon && HOME=/home/mikka-runner ./node_modules/.bin/tsx bin/cloud-worker.ts > /home/mikka-runner/.mikka/worker-bootstrap.log 2>&1', { user: 'mikka-runner', background: true, timeoutMs: 0 })
    const deadline = Date.now() + 30_000
    do {
      const ready = await pool.query(`SELECT 1 FROM devices d JOIN device_tokens t ON t."boundDeviceId"=d.id
        WHERE d.id=$1 AND d."ownerId"=$2 AND d.kind='cloud' AND d."lastSeenAt">=$3
          AND t."tokenHash"=$4 AND t."revokedAt" IS NULL AND t."lastUsedAt">=$3`, [credential.deviceId, actor.userId, started, hash])
      if (ready.rowCount) return { deviceId: credential.deviceId }
      await new Promise(resolve => setTimeout(resolve, 500))
    } while (Date.now() < deadline)
    throw new CloudWorkerError('worker_not_registered', sandbox.sandboxId)
  } finally {
    // A generation-specific path prevents a stale handoff deleting a newer one.
    await sandbox.commands.run(`if test -f ${temporary}; then unlink ${temporary}; fi`, { user: 'root', timeoutMs: 10_000 }).catch(() => undefined)
    await releaseWorkerLease(pool, actor, leaseId)
  }
}
