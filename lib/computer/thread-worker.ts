import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Sandbox } from 'e2b'
import type { Pool } from 'pg'
import * as provider from './e2b-provider'
import { claimThreadWorkerLease, provisionThreadDevice, releaseThreadWorkerLease, renewThreadWorkerLease } from './thread-device'

type Actor = { userId: string; workspaceId: string }

/** Start the trusted daemon inside exactly one thread's sandbox. Device
 * credentials are handed to the runner by a private file, never argv/env. */
export async function startThreadWorker(pool: Pool, actor: Actor, runId: string, sandbox: Sandbox, server: string, sourceSha: string, runtime = provider) {
  const url = new URL(server)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid cloud worker configuration')
  const protectionBypass = process.env.VERCEL_ENV === 'preview' ? process.env.MIKKA_CLOUD_PREVIEW_BYPASS : undefined
  if (protectionBypass && (!url.hostname.endsWith('.vercel.app') || !/^[A-Za-z0-9_-]{20,256}$/.test(protectionBypass))) throw new Error('Invalid cloud worker configuration')
  const leaseId = randomUUID()
  if (!await claimThreadWorkerLease(pool, actor, runId, sandbox.sandboxId, leaseId)) throw new Error('Thread worker provisioning is busy or unavailable')
  const temporary = `/run/mikka-private/worker-${leaseId}.next`
  try {
    const pinned = await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' })
    if (pinned.trim() !== sourceSha) throw new Error('Cloud worker version mismatch')
    const existing = await pool.query(`SELECT d.id FROM thread_machines m JOIN devices d ON d.id=m."deviceId"
      JOIN device_tokens t ON t."boundDeviceId"=d.id AND t."boundWorkspaceId"=m."workspaceId" AND t."userId"=m."ownerId"
      WHERE m."runId"=$1 AND m."workspaceId"=$2 AND m."ownerId"=$3 AND m."sandboxId"=$4
        AND d."ownerId"=$3 AND d.kind='cloud' AND d."lastSeenAt">now()-interval '60 seconds'
        AND t."lastUsedAt">now()-interval '2 minutes' AND t."revokedAt" IS NULL AND t."expiresAt">now()+interval '1 hour' LIMIT 1`,
    [runId, actor.workspaceId, actor.userId, sandbox.sandboxId])
    if (existing.rowCount) return { deviceId: existing.rows[0].id as string }
    await runtime.ensureHostedRunnerImage(sandbox)
    if (!await renewThreadWorkerLease(pool, actor, runId, leaseId)) throw new Error('Thread worker lease expired')
    await sandbox.commands.run('install -d -o root -g root -m 0700 /run/mikka-private', { user: 'root', timeoutMs: 10_000 })
    const started = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const credential = await provisionThreadDevice(pool, actor, runId, new Date(started.getTime() + 24 * 60 * 60_000), leaseId)
    const hash = createHash('sha256').update(credential.token).digest('hex')
    await sandbox.files.write(temporary, JSON.stringify({ deviceId: credential.deviceId, workspaceId: actor.workspaceId, credential: credential.token, server: url.toString(), ...(protectionBypass ? { protectionBypass } : {}) }), { user: 'root' })
    if (!await renewThreadWorkerLease(pool, actor, runId, leaseId)) throw new Error('Thread worker lease expired')
    await sandbox.commands.run(`install -d -o mikka-runner -g mikka-runner -m 0700 /home/mikka-runner/.mikka && install -o mikka-runner -g mikka-runner -m 0600 ${temporary} /home/mikka-runner/.mikka/bootstrap.next && mv /home/mikka-runner/.mikka/bootstrap.next /home/mikka-runner/.mikka/bootstrap.json && unlink ${temporary}`, { user: 'root', timeoutMs: 10_000 })
    await sandbox.commands.run('cd /opt/mikka/worker/packages/daemon && HOME=/home/mikka-runner ./node_modules/.bin/tsx bin/cloud-worker.ts > /home/mikka-runner/.mikka/worker-bootstrap.log 2>&1', { user: 'mikka-runner', background: true, timeoutMs: 0 })
    const deadline = Date.now() + 30_000
    do {
      const ready = await pool.query(`SELECT 1 FROM devices d JOIN device_tokens t ON t."boundDeviceId"=d.id
        WHERE d.id=$1 AND d."ownerId"=$2 AND d.kind='cloud' AND d."lastSeenAt">=$3
          AND t."tokenHash"=$4 AND t."revokedAt" IS NULL AND t."lastUsedAt">=$3`, [credential.deviceId, actor.userId, started, hash])
      if (ready.rowCount) return { deviceId: credential.deviceId }
      await new Promise(resolve => setTimeout(resolve, 500))
    } while (Date.now() < deadline)
    throw new Error('Thread worker did not register')
  } finally {
    await sandbox.commands.run(`if test -f ${temporary}; then unlink ${temporary}; fi`, { user: 'root', timeoutMs: 10_000 }).catch(() => undefined)
    await releaseThreadWorkerLease(pool, actor, runId, leaseId)
  }
}
