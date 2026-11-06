import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { Sandbox } from 'e2b'
import { bootstrapOfficialInstance, type OfficialE2BTemplate } from '@/lib/computer/official-runtime'
import { CLOUD_WORKER_PRELOAD_COMMAND } from '@/lib/computer/worker-command'
import { workerCommand } from './thread-worker-logs'
import { CLAIM_LIMIT, POOL_IDLE_DAYS, WARMING_LIMIT } from './thread-machine-pool-due'

/**
 * Ready thread machines (#1507). A new official E2B instance takes ~1 s to
 * create, but adding Mikka's worker to it (/opt/mikka: Node, `pnpm install`,
 * the worker build) takes ~60 s. Each owner keeps one instance per official
 * template already bootstrapped, its worker preloaded and waiting for a
 * bootstrap, and paused; a dispatch resumes it (<1 s) instead of creating and
 * bootstrapping one.
 *
 * Decision 2026-11-03-1430 holds: these are new instances of the unchanged
 * official templates with Mikka only in /opt/mikka; no template or snapshot is
 * derived from them. A ready instance has no device identity, credential or
 * workspace; those arrive only after it is claimed for a run.
 *
 * Cost: everything runs on the owner's own E2B key (orchestration § 2). One
 * refill costs one bootstrap (~60 s of a 2 vCPU instance); a paused instance
 * uses no compute. A slot is refilled only after a dispatch used its template,
 * and one left unused for POOL_IDLE_DAYS is killed.
 */
const POOL_TIMEOUT_MS = 10 * 60_000
const RUN_TIMEOUT_MS = 15 * 60_000

type Options = { apiKey: string, proxy?: string }
export type PoolProvider = {
  options(ownerId: string): Promise<Options>
  create(template: OfficialE2BTemplate, key: string, options: Options): Promise<Pick<Sandbox, 'sandboxId' | 'commands' | 'pause'>>
  connect(sandboxId: string, options: Options): Promise<Sandbox>
  kill(sandboxId: string, options: Options): Promise<unknown>
  prepare(sandbox: Pick<Sandbox, 'commands'>, template: OfficialE2BTemplate): Promise<void>
}

/** Bootstrap, preload the worker so it waits for a handoff, then pause. */
async function prepareReadyInstance(sandbox: Pick<Sandbox, 'commands'>, template: OfficialE2BTemplate) {
  await bootstrapOfficialInstance(sandbox, template)
  await sandbox.commands.run(workerCommand(CLOUD_WORKER_PRELOAD_COMMAND), { user: 'user', background: true, timeoutMs: 0 })
  await sandbox.commands.run('for i in $(seq 1 300); do test -s /home/user/.mikka/preloaded.pid && exit 0; sleep .05; done; exit 1', { user: 'user', timeoutMs: 30_000 })
  // `pnpm install` leaves a large page cache; the instance resumes from its
  // memory, so drop it before pausing (measured: 9 s first resume without).
  await sandbox.commands.run('sync; echo 3 > /proc/sys/vm/drop_caches', { user: 'root', timeoutMs: 30_000 })
}

export const threadMachinePoolProvider: PoolProvider = {
  options: async ownerId => ({ apiKey: await (await import('@/lib/secrets/e2b-runtime')).e2bApiKey(ownerId, 'Cloud runtime unavailable'), proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }),
  create: (template, key, options) => Sandbox.create(template, { ...options, idempotencyKey: key, timeoutMs: POOL_TIMEOUT_MS, metadata: { application: 'mikka-thread-pool' }, lifecycle: { onTimeout: 'pause', autoResume: false } }),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, { ...options, timeoutMs: RUN_TIMEOUT_MS }),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
  prepare: prepareReadyInstance,
}

const workerSha = (env: Record<string, string | undefined>) => env.MIKKA_CLOUD_WORKER_SHA ?? ''

/**
 * Claims this owner's ready instance of `template` for one provisioning
 * operation and resumes it, or returns null (no ready instance, or it could not
 * be resumed). A retry of the same operation gets the same instance back.
 */
export async function claimReadyThreadMachine(pool: Pick<Pool, 'query'>, ownerId: string, template: OfficialE2BTemplate, operationId: string,
  provider: PoolProvider = threadMachinePoolProvider, env: Record<string, string | undefined> = process.env): Promise<Sandbox | null> {
  const sha = workerSha(env)
  if (!sha) return null
  const { rows: [row] } = await pool.query<{ sandboxId: string }>(`UPDATE thread_machine_pool SET "claimedBy"=$4,"claimedAt"=now()
    WHERE id=COALESCE((SELECT id FROM thread_machine_pool WHERE "claimedBy"=$4 AND "ownerId"=$1),
      (SELECT id FROM thread_machine_pool WHERE "ownerId"=$1 AND template=$2 AND "workerSha"=$3 AND state='ready' AND "claimedBy" IS NULL
        ORDER BY "readyAt" LIMIT 1 FOR UPDATE SKIP LOCKED)) RETURNING "sandboxId"`, [ownerId, template, sha, operationId])
  if (!row) return null
  const options = await provider.options(ownerId)
  try { return await provider.connect(row.sandboxId, options) } catch {
    // Gone or broken (expired, killed outside Mikka): forget it, start fresh.
    await provider.kill(row.sandboxId, options).catch(() => undefined)
    await pool.query('DELETE FROM thread_machine_pool WHERE "sandboxId"=$1', [row.sandboxId])
    return null
  }
}

/** The run recorded the claimed instance as its own machine; it leaves the pool. */
export async function forgetClaimedThreadMachine(pool: Pick<Pool, 'query'>, sandboxId: string) {
  await pool.query('DELETE FROM thread_machine_pool WHERE "sandboxId"=$1 AND "claimedBy" IS NOT NULL', [sandboxId])
}

/**
 * Prepares one ready instance of `template` for this owner unless one is
 * ready or being prepared. Never throws: a failed refill only means the next
 * dispatch starts a fresh instance, as before the pool.
 */
export async function refillThreadMachinePool(pool: Pick<Pool, 'query'>, ownerId: string, template: OfficialE2BTemplate,
  provider: PoolProvider = threadMachinePoolProvider, env: Record<string, string | undefined> = process.env) {
  const sha = workerSha(env)
  if (!sha) return 'unconfigured'
  let options: Options | undefined, sandboxId: string | undefined
  const id = randomUUID()
  try {
    // An instance of an older worker release is never handed out; free its slot.
    const { rows: stale } = await pool.query<{ sandboxId: string | null }>(`DELETE FROM thread_machine_pool WHERE "ownerId"=$1 AND template=$2 AND "workerSha"<>$3
      AND "claimedBy" IS NULL AND state='ready' RETURNING "sandboxId"`, [ownerId, template, sha])
    // One unclaimed slot per owner and template (unique index).
    const slot = await pool.query(`INSERT INTO thread_machine_pool (id,"ownerId",template,"workerSha",state) VALUES ($1,$2,$3,$4,'warming')
      ON CONFLICT DO NOTHING RETURNING id`, [id, ownerId, template, sha])
    if (stale.length) {
      options = await provider.options(ownerId)
      for (const row of stale) if (row.sandboxId) await provider.kill(row.sandboxId, options).catch(() => undefined)
    }
    if (!slot.rowCount) return 'full'
    options ??= await provider.options(ownerId)
    const sandbox = await provider.create(template, id, options)
    sandboxId = sandbox.sandboxId
    await pool.query('UPDATE thread_machine_pool SET "sandboxId"=$2 WHERE id=$1', [id, sandboxId])
    await provider.prepare(sandbox, template)
    await sandbox.pause()
    const ready = await pool.query(`UPDATE thread_machine_pool SET state='ready',"readyAt"=now() WHERE id=$1 AND state='warming' RETURNING id`, [id])
    if (!ready.rowCount) { await provider.kill(sandboxId, options).catch(() => undefined); return 'cancelled' }
    return 'ready'
  } catch (error) {
    console.warn(JSON.stringify({ msg: 'thread_machine_pool_refill_failed', template, error: error instanceof Error ? error.name : 'unknown' }))
    if (sandboxId && options) await provider.kill(sandboxId, options).catch(() => undefined)
    await pool.query(`DELETE FROM thread_machine_pool WHERE id=$1 AND "claimedBy" IS NULL`, [id]).catch(() => undefined)
    return 'failed'
  }
}

/**
 * Kills instances nobody will use (run-recovery sweep): unused for
 * POOL_IDLE_DAYS, a refill that died, or a claim its run never recorded.
 * A claimed instance its run did record is only forgotten, never killed.
 */
export async function reapThreadMachinePool(pool: Pick<Pool, 'query'>, provider: PoolProvider = threadMachinePoolProvider) {
  await pool.query(`DELETE FROM thread_machine_pool p WHERE "claimedBy" IS NOT NULL AND EXISTS(SELECT 1 FROM thread_machines m WHERE m."sandboxId"=p."sandboxId")`)
  const { rows } = await pool.query<{ id: string; ownerId: string; sandboxId: string | null }>(`SELECT id,"ownerId","sandboxId" FROM thread_machine_pool
    WHERE (state='ready' AND "claimedBy" IS NULL AND "readyAt" < now() - make_interval(days => ${POOL_IDLE_DAYS}))
      OR (state='warming' AND "createdAt" < now() - interval '${WARMING_LIMIT}')
      OR ("claimedBy" IS NOT NULL AND "claimedAt" < now() - interval '${CLAIM_LIMIT}')`)
  let killed = 0
  for (const row of rows) {
    try {
      if (row.sandboxId) await provider.kill(row.sandboxId, await provider.options(row.ownerId))
      await pool.query('DELETE FROM thread_machine_pool WHERE id=$1', [row.id])
      killed++
    } catch { /* retried on the next sweep */ }
  }
  return { killed, pending: rows.length - killed }
}
