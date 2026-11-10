import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pool, withDatabaseClient } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { artifactStorage, deleteArtifactObject } from '@/lib/artifacts/storage'
import { auditDigest } from '@/lib/audit/integrity'
import { accountStorageKeys, deleteMainAccountData, deleteWorkspaceData, freezeTaskRetention, planWorkspaces, type Plan } from './delete'
import type { AccountCleanupReport } from './cleanup-result'
import { cleanupAccountConnections } from './external-cleanup'
import { AccountDeletionBusy, AccountDeletionLockLost, acquireAccountDeletionLock } from './deletion-lock'
import { teardownWorkspaceMachines } from '@/lib/cloud-computer/workspace-teardown'
import { armDueTimerSoon } from '@/lib/due-timer'
import { GovernanceError } from '@/lib/governance/errors'
import { lockAccountOrganizationOwnership } from '@/lib/governance/organization-ownership'

export type DeletionStage = 'preparing' | 'requested' | 'external_pending' | 'main_deleted' | 'workspace_deleted' | 'storage_pending' | 'completed' | 'cancelled'
export interface AccountDeletionJob {
  id: string; subjectUserId: string; subjectEmailHash: string; requestedAt: Date; stage: DeletionStage
  plan: Plan | null; pendingObjects: string[]; storageNotBefore: Date | null
  blockedReasons: string[]; warnings: string[]; completedAt: Date | null; retentionUntil: Date | null; updatedAt: Date
}
export interface AccountDeletionOptions {
  mainPool?: Pool; workspacePool?: Pool
  /** Trusted server adapter. Return fixed reason codes for resources that still require cleanup. */
  externalCleanup?: (subject: string, database: Pool) => Promise<string[] | AccountCleanupReport>
  deleteObject?: (key: string) => Promise<void>
  now?: () => Date
  /** Restore-only preservation decision from the independently retained current journal. */
  replayPlan?: Plan
}
const targets = (o: AccountDeletionOptions) => ({ main: o.mainPool ?? pool, workspace: o.workspacePool ?? workspacePool })
const hashEmail = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
const lockKey = (subject: string) => `mikka-account-write:${subject}`

async function transaction<T>(database: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect()
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
async function guard(client: PoolClient, userId: string, id: string, requestedAt: Date) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey(userId)])
  await client.query('INSERT INTO account_deletion_guards("subjectId","jobId","requestedAt") VALUES($1,$2,$3) ON CONFLICT("subjectId") DO UPDATE SET "jobId"=excluded."jobId","requestedAt"=excluded."requestedAt"', [userId, id, requestedAt])
}
async function load(database: Pick<Pool, 'query'>, id: string): Promise<AccountDeletionJob> {
  const job = (await database.query<AccountDeletionJob>('SELECT * FROM account_deletion_jobs WHERE id=$1', [id])).rows[0]
  if (!job) throw new Error('accountDeletionUnavailable')
  return job
}
/** Deliberately omits subject identity, object names and the workspace preservation plan. */
export function deletionReceipt(job: AccountDeletionJob) {
  return { id: job.id, stage: job.stage, requestedAt: job.requestedAt.toISOString(), completedAt: job.completedAt?.toISOString() ?? null,
    remainingObjects: job.pendingObjects.length, blockedReasons: job.blockedReasons, warnings: job.warnings }
}
export async function readAccountDeletion(userId: string, id: string, options: AccountDeletionOptions = {}) {
  const job = await load(targets(options).main, id)
  if (job.subjectUserId !== userId) throw new Error('accountDeletionUnavailable')
  return deletionReceipt(job)
}

/** Session + typed-email authorization belongs to the existing action/API, never to a supplied user ID. */
export async function requestAccountDeletion(userId: string, email: string, requestId: string = randomUUID(), options: AccountDeletionOptions = {}): Promise<{ ok: true; id: string } | { ok: false; soleAdminOf: string[] }> {
  const { main } = targets(options)
  const id = await transaction(main, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey(userId)])
    const existing = (await client.query<{ id: string }>('SELECT id FROM account_deletion_jobs WHERE "subjectUserId"=$1 AND stage<>\'cancelled\'', [userId])).rows[0]
    if (existing) return existing.id
    const user = (await client.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1 FOR UPDATE', [userId])).rows[0]
    if (!user || hashEmail(user.email) !== hashEmail(email)) throw new Error('accountDeletionUnavailable')
    await client.query('INSERT INTO account_deletion_jobs(id,"subjectUserId","subjectEmailHash",stage) VALUES($1,$2,$3,\'preparing\')', [requestId, userId, hashEmail(email)])
    await guard(client, userId, requestId, options.now?.() ?? new Date())
    return requestId
  })
  const { client: lease, close, assertHeld, rethrow } = await acquireAccountDeletionLock(main, id)
  try {
    const job = await load(lease, id)
    assertHeld()
    if (job.stage === 'preparing') {
      const refused = await prepare(job, options, assertHeld)
      if (refused && 'lastOrganizationOwner' in refused) throw new GovernanceError('last_owner')
      if (refused) return { ok: false, soleAdminOf: refused.soleAdminOf }
    }
  } catch (error) { return await rethrow(error) } finally { await close() }
  // The deletion itself runs on the account-deletions due timer, now (#1371).
  armDueTimerSoon('account-deletions')
  return { ok: true, id }
}

type PreparationRefusal = { soleAdminOf: string[] } | { lastOrganizationOwner: true }
const lastOrganizationOwner = (error: unknown): error is GovernanceError =>
  error instanceof GovernanceError && error.detail === 'last_owner'

async function clearWorkspaceGuards(client: PoolClient, job: AccountDeletionJob) {
  await client.query('DELETE FROM account_deletion_workspace_guards WHERE "jobId"=$1', [job.id])
  await client.query('DELETE FROM account_deletion_guards WHERE "subjectId"=$1 AND "jobId"=$2', [job.subjectUserId, job.id])
}
async function cancelUnstartedMain(job: AccountDeletionJob, main: Pool, assertHeld: () => void, reason: 'sole_workspace_admin' | 'last_owner') {
  await transaction(main, async client => {
    assertHeld()
    await client.query('DELETE FROM account_deletion_guards WHERE "subjectId"=$1 AND "jobId"=$2', [job.subjectUserId, job.id])
    await client.query(`UPDATE account_deletion_jobs SET stage='cancelled',"blockedReasons"=$2,"updatedAt"=now() WHERE id=$1`, [job.id, JSON.stringify([reason])])
    assertHeld()
  })
}

async function prepare(job: AccountDeletionJob, options: AccountDeletionOptions, assertHeld: () => void): Promise<PreparationRefusal | null> {
  const { main, workspace } = targets(options)
  assertHeld()
  const plan = await transaction(workspace, async client => {
    assertHeld()
    // This canonical guard and the Organization owner check commit together.
    // A refused request removes its guard while still holding the Org row.
    await guard(client, job.subjectUserId, job.id, job.requestedAt)
    let planned: Plan | PreparationRefusal = await planWorkspaces(drizzle(client), job.subjectUserId, main)
    if (!('soleAdminOf' in planned)) {
      try { await lockAccountOrganizationOwnership(drizzle(client), job.subjectUserId) }
      catch (error) {
        if (!lastOrganizationOwner(error)) throw error
        planned = { lastOrganizationOwner: true }
      }
    }
    if ('soleAdminOf' in planned || 'lastOrganizationOwner' in planned) {
      await clearWorkspaceGuards(client, job)
    } else if (planned.solo.length) {
      await client.query('INSERT INTO account_deletion_workspace_guards("workspaceId","jobId") SELECT unnest($1::uuid[]),$2 ON CONFLICT DO NOTHING', [planned.solo, job.id])
    }
    assertHeld()
    return planned
  })
  assertHeld()
  if ('soleAdminOf' in plan || 'lastOrganizationOwner' in plan) {
    await cancelUnstartedMain(job, main, assertHeld, 'lastOrganizationOwner' in plan ? 'last_owner' : 'sole_workspace_admin')
    return plan
  }
  await main.query(`UPDATE account_deletion_jobs SET plan=$2,stage='requested',"updatedAt"=now() WHERE id=$1 AND stage='preparing'`, [job.id, JSON.stringify(plan)])
  return null
}

/** Idempotent stages commit separately in the two stores. A workspace failure never rewinds an already committed main-store deletion. */
export async function resumeAccountDeletion(id: string, options: AccountDeletionOptions = {}): Promise<AccountDeletionJob> {
  const { main, workspace } = targets(options)
  // A dedicated direct session serializes resumption; stages still commit independently.
  const { client: lease, close, assertHeld, rethrow } = await acquireAccountDeletionLock(main, id)
  try {
    let job = await load(lease, id)
    assertHeld()
    if (job.stage === 'completed' || job.stage === 'cancelled') return job
    if (job.stage === 'preparing') { await prepare(job, options, assertHeld); job = await load(lease, id) }
    if (job.stage === 'cancelled') return job
    if (job.stage === 'requested' || job.stage === 'external_pending') {
      try {
        await transaction(workspace, async client => {
          assertHeld()
          await guard(client, job.subjectUserId, id, job.requestedAt)
          await lockAccountOrganizationOwnership(drizzle(client), job.subjectUserId)
          assertHeld()
        })
      } catch (error) {
        if (!lastOrganizationOwner(error) || job.stage !== 'requested' || options.replayPlan) throw error
        // No irreversible step has started. Keep the remaining owner usable,
        // including when two owners requested deletion concurrently.
        await transaction(workspace, client => clearWorkspaceGuards(client, job))
        await cancelUnstartedMain(job, main, assertHeld, 'last_owner')
        return await load(lease, id)
      }
      await lease.query('UPDATE account_deletion_jobs SET stage=\'external_pending\',"updatedAt"=now() WHERE id=$1', [id])
      let report: AccountCleanupReport
      try {
        const result = await withDatabaseClient(lease, () => (options.externalCleanup ?? cleanupAccountConnections)(job.subjectUserId, main))
        report = Array.isArray(result) ? { blockedReasons: result, warnings: [] } : result
      } catch { report = { blockedReasons: ['external_cleanup_failed'], warnings: [] } }
      assertHeld()
      const blocked = report.blockedReasons
      await lease.query('UPDATE account_deletion_jobs SET warnings=$2 WHERE id=$1', [id, JSON.stringify([...new Set([...job.warnings, ...report.warnings])])])
      if (blocked.length) {
        await lease.query('UPDATE account_deletion_jobs SET "blockedReasons"=$2,"updatedAt"=now() WHERE id=$1', [id, JSON.stringify([...new Set(blocked)])])
        return await load(lease, id)
      }
      // Freeze every solo workspace before removing any main-store content. New membership writes
      // are rejected by its durable guard, including after a failed workspace commit/restart.
      assertHeld()
      const frozen = await transaction(workspace, async client => {
        assertHeld()
        const plan = options.replayPlan ?? await planWorkspaces(drizzle(client), job.subjectUserId, main)
        await lockAccountOrganizationOwnership(drizzle(client), job.subjectUserId)
        if (!('soleAdminOf' in plan) && plan.solo.length) await client.query('INSERT INTO account_deletion_workspace_guards("workspaceId","jobId") SELECT unnest($1::uuid[]),$2 ON CONFLICT DO NOTHING', [plan.solo, id])
        assertHeld()
        return plan
      })
      assertHeld()
      if ('soleAdminOf' in frozen) {
        await lease.query('UPDATE account_deletion_jobs SET "blockedReasons"=\'["sole_workspace_admin"]\',"updatedAt"=now() WHERE id=$1', [id])
        return await load(lease, id)
      }
      // Machines of anyone else left in a workspace that goes (a former member's Bot computer or thread
      // machines) are fenced and killed before their rows go; the person's own went in the external step.
      // A restore replay never reaches a provider.
      if (!options.replayPlan) for (const workspaceId of frozen.solo) {
        assertHeld()
        await teardownWorkspaceMachines(main, workspaceId, { exceptOwner: job.subjectUserId })
        assertHeld()
      }
      assertHeld()
      await transaction(workspace, async workspaceClient => {
        assertHeld()
        const checked = await planWorkspaces(drizzle(workspaceClient), job.subjectUserId, main)
        if (!options.replayPlan && ('soleAdminOf' in checked || auditDigest(checked) !== auditDigest(frozen))) throw new Error('accountDeletionWorkspaceChanged')
        // Existing order is Workspace -> Organization -> APP. Keep the Org
        // ownership decision locked until the APP deletion has committed.
        await lockAccountOrganizationOwnership(drizzle(workspaceClient), job.subjectUserId)
        // Include objects written before the request's write barrier, and durable old-avatar references.
        assertHeld()
        const retained = await transaction(main, async client => {
          assertHeld()
          const retained = await freezeTaskRetention(client, job.subjectUserId, frozen)
          const objects = await accountStorageKeys(client, job.subjectUserId, retained)
          const notBefore = !options.deleteObject && artifactStorage() === 'inline' ? (options.now?.() ?? new Date()) : objects.notBefore
          assertHeld()
          await deleteMainAccountData(client, job.subjectUserId, retained)
          await client.query('UPDATE account_deletion_jobs SET stage=\'main_deleted\',plan=$4,"pendingObjects"=$2,"storageNotBefore"=$3,"blockedReasons"=\'[]\',"updatedAt"=now() WHERE id=$1',
            [id, JSON.stringify(objects.keys), notBefore, JSON.stringify(retained)])
          assertHeld()
          return retained
        })
        assertHeld()
        // Workspace row locks remain held across the main commit; this is explicitly two commits.
        await deleteWorkspaceData(drizzle(workspaceClient), job.subjectUserId, job.subjectEmailHash, retained)
        assertHeld()
      })
      await lease.query('UPDATE account_deletion_jobs SET stage=\'workspace_deleted\',"updatedAt"=now() WHERE id=$1', [id])
      job = await load(lease, id)
    }
    if (job.stage === 'main_deleted') {
      assertHeld()
      await transaction(workspace, async client => {
        assertHeld()
        await guard(client, job.subjectUserId, id, job.requestedAt)
        await deleteWorkspaceData(drizzle(client), job.subjectUserId, job.subjectEmailHash, job.plan!)
        assertHeld()
      })
      await lease.query('UPDATE account_deletion_jobs SET stage=\'workspace_deleted\',"updatedAt"=now() WHERE id=$1', [id])
      job = await load(lease, id)
    }
    if (job.stage === 'workspace_deleted' || job.stage === 'storage_pending') {
      const notBefore = job.storageNotBefore?.getTime() ?? 0
      if (job.pendingObjects.length && notBefore > (options.now?.() ?? new Date()).getTime()) {
        await lease.query('UPDATE account_deletion_jobs SET stage=\'storage_pending\',"blockedReasons"=\'["upload_grants_not_expired"]\',"updatedAt"=now() WHERE id=$1', [id])
        return await load(lease, id)
      }
      const remove = options.deleteObject ?? (async (key: string) => { if (artifactStorage() === 'r2') await deleteArtifactObject(key) })
      for (const key of job.pendingObjects) {
        assertHeld()
        try { await remove(key) }
        catch {
          await lease.query('UPDATE account_deletion_jobs SET stage=\'storage_pending\',"blockedReasons"=\'["object_cleanup_failed"]\',"updatedAt"=now() WHERE id=$1', [id])
          return await load(lease, id)
        }
        assertHeld()
        await lease.query('UPDATE account_deletion_jobs SET "pendingObjects"="pendingObjects" - $2::text,"updatedAt"=now() WHERE id=$1', [id, key])
      }
      await lease.query('UPDATE account_deletion_jobs SET stage=\'completed\',"completedAt"=now(),"blockedReasons"=\'[]\',"updatedAt"=now() WHERE id=$1', [id])
    }
    return await load(lease, id)
  } catch (error) {
    if (lastOrganizationOwner(error)) {
      assertHeld()
      // An irreversible stage may already have run: keep its receipt/guards
      // retryable, and do not describe it as an undone cancellation.
      await lease.query(`UPDATE account_deletion_jobs SET "blockedReasons"='["last_owner"]',"updatedAt"=now() WHERE id=$1`, [id])
      return await load(lease, id)
    }
    return await rethrow(error)
  } finally { await close() }
}

/** Cancellation is possible only before any external or irreversible step starts. */
export async function cancelAccountDeletion(userId: string, id: string, options: AccountDeletionOptions = {}): Promise<boolean> {
  const { main, workspace } = targets(options)
  const { client: lease, close, assertHeld, rethrow } = await acquireAccountDeletionLock(main, id)
  try {
    const job = await load(lease, id)
    assertHeld()
    if (job.subjectUserId !== userId) throw new Error('accountDeletionUnavailable')
    if (!['preparing', 'requested'].includes(job.stage)) return false
    // Removing the workspace guard first is safe: the main guard still rejects managed writes.
    assertHeld()
    await workspace.query('DELETE FROM account_deletion_workspace_guards WHERE "jobId"=$1', [id])
    assertHeld()
    await workspace.query('DELETE FROM account_deletion_guards WHERE "subjectId"=$1 AND "jobId"=$2', [userId, id])
    await transaction(main, async client => {
      assertHeld()
      await client.query('DELETE FROM account_deletion_guards WHERE "subjectId"=$1 AND "jobId"=$2', [userId, id])
      await client.query('UPDATE account_deletion_jobs SET stage=\'cancelled\',"updatedAt"=now() WHERE id=$1', [id])
      assertHeld()
    })
    return true
  } catch (error) { return await rethrow(error) } finally { await close() }
}

type ManifestJob = Omit<AccountDeletionJob, 'requestedAt' | 'storageNotBefore' | 'completedAt' | 'retentionUntil' | 'updatedAt'> & { requestedAt: string; storageNotBefore: string | null; completedAt: string | null; retentionUntil: string | null; updatedAt: string }
export interface AccountDeletionManifest {
  format: 'mikka-account-deletions'; version: 1; createdAt: string; jobs: ManifestJob[]; digest: string
}
/** Store this outside account backups. Its digest needs an independent protected anchor. It is not a signature. */
export async function exportAccountDeletionManifest(options: AccountDeletionOptions = {}): Promise<AccountDeletionManifest> {
  const rows = (await targets(options).main.query<AccountDeletionJob>('SELECT * FROM account_deletion_jobs WHERE stage<>\'cancelled\' ORDER BY id')).rows
  const jobs: ManifestJob[] = JSON.parse(JSON.stringify(rows))
  const value = { format: 'mikka-account-deletions' as const, version: 1 as const, createdAt: new Date().toISOString(), jobs }
  return { ...value, digest: auditDigest(value) }
}
/** Restores remain isolated until this returns. Pending live deletions require operator resolution, never silent resurrection. */
export async function applyAccountDeletionManifest(manifest: AccountDeletionManifest, options: Required<Pick<AccountDeletionOptions, 'mainPool' | 'workspacePool'>> & AccountDeletionOptions) {
  const { digest, ...body } = manifest
  if (manifest.format !== 'mikka-account-deletions' || manifest.version !== 1 || auditDigest(body) !== digest) throw new Error('accountDeletionManifestInvalid')
  if (manifest.jobs.some(job => job.stage !== 'completed' || !job.plan || job.pendingObjects.length)) throw new Error('accountDeletionManifestHasPendingJobs')
  const ids = new Set<string>(), subjects = new Set<string>()
  for (const job of manifest.jobs) {
    if (ids.has(job.id) || subjects.has(job.subjectUserId)) throw new Error('accountDeletionManifestInvalid')
    ids.add(job.id); subjects.add(job.subjectUserId)
  }
  for (const source of manifest.jobs) {
    const replayPlan = await transaction(options.mainPool, async client => {
      const existing = (await client.query<AccountDeletionJob>('SELECT * FROM account_deletion_jobs WHERE id=$1 FOR UPDATE', [source.id])).rows[0]
      if (existing && (existing.subjectUserId !== source.subjectUserId || existing.subjectEmailHash !== source.subjectEmailHash)) throw new Error('accountDeletionManifestInvalid')
      // A previous replay may have retained tasks present only in the old backup.
      // Preserve that frozen decision without expanding the source solo deletion set.
      const retained: Plan = { ...source.plan!, keptIssueIds: [...new Set([
        ...source.plan!.keptIssueIds, ...(existing?.plan?.keptIssueIds ?? []),
      ])].sort() }
      await guard(client, source.subjectUserId, source.id, new Date(source.requestedAt))
      // A retry must preserve the pending object list after its DB pointers have already gone.
      // A completed row from the old dump is harmless to replay and captures old file references.
      if (existing && !['completed', 'cancelled'].includes(existing.stage)) {
        await client.query('UPDATE account_deletion_jobs SET plan=$2,stage=CASE WHEN stage=\'preparing\' THEN \'requested\' ELSE stage END WHERE id=$1', [source.id, JSON.stringify(retained)])
        return retained
      }
      await client.query(`INSERT INTO account_deletion_jobs(id,"subjectUserId","subjectEmailHash","requestedAt",stage,plan,"retentionUntil",warnings) VALUES($1,$2,$3,$4,'requested',$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET stage='requested',plan=excluded.plan,"pendingObjects"='[]',"completedAt"=NULL,"blockedReasons"='[]'`,
      [source.id, source.subjectUserId, source.subjectEmailHash, source.requestedAt, JSON.stringify(retained), source.retentionUntil, JSON.stringify(source.warnings ?? [])])
      return retained
    })
    // Managed custody cleanup completed in the current journal; its warnings preserve upstream exceptions. Restore replays only local deletion against explicit isolated targets.
    await resumeAccountDeletion(source.id, { ...options, externalCleanup: async () => ({ blockedReasons: [], warnings: source.warnings ?? [] }), replayPlan })
  }
  const remaining = (await options.mainPool.query('SELECT id FROM account_deletion_jobs WHERE id=ANY($1::uuid[]) AND stage<>\'completed\'', [[...ids]])).rows
  if (remaining.length) throw new Error('accountDeletionRestoreCleanupPending')
  return { applied: ids.size }
}

/** Private receipt capability is returned only after owner confirmation; it reveals no personal data. */
export async function readAccountDeletionReceipt(id: string, options: AccountDeletionOptions = {}) {
  return deletionReceipt(await load(targets(options).main, id))
}
export async function sweepAccountDeletions(options: AccountDeletionOptions = {}) {
  const { main } = targets(options)
  const jobs = (await main.query<{ id: string }>('SELECT id FROM account_deletion_jobs WHERE stage NOT IN (\'completed\',\'cancelled\') ORDER BY "updatedAt",id LIMIT 5')).rows
  let completed = 0, pending = 0
  for (const { id } of jobs) {
    try { if ((await resumeAccountDeletion(id, options)).stage === 'completed') completed++; else pending++ }
    catch (error) { pending++; if (error instanceof AccountDeletionBusy || error instanceof AccountDeletionLockLost) continue; await main.query('UPDATE account_deletion_jobs SET "updatedAt"=now(),"blockedReasons"=\'["deletion_step_failed"]\' WHERE id=$1', [id]) }
  }
  return { scanned: jobs.length, completed, pending }
}
