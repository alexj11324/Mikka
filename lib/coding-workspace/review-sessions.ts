import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { afterDatabaseCommit, captureDatabaseQuery } from '../db/commit-effects'
import { armDueTimerAfterCommit, armDueTimerSoon } from '../due-timer'
import { ReviewAuthorityError, type TaskReviewAuthority } from './review-authority'
import { readIssueMetadata } from '../issue-metadata'
import { THREAD_MACHINE_BUDGET_MS } from '../cloud-computer/thread-lifecycle'
import { taskThreadRunPredicate } from '../task-thread-run'

export const REVIEW_SESSION_MS = 5 * 60_000
export type ReviewSessionKind = 'terminal' | 'preview'
export type ReviewSessionLease = { id: string; expiresAt:string; reviewOperationId?:string; reviewKind?:ReviewSessionKind }
type SponsoredClose = { taskId:string; repositoryKey:string; operationId:string }
export type ReviewRevokeTarget = { sponsored?:SponsoredClose; runId: string; ownerId: string; workspaceId: string; sandboxId: string }
export type ReviewSessionTarget = { runIds: readonly string[] } | { userId: string } | { workspaceId: string; ownerId?: string }
  | { taskId: string } | { taskIds: readonly string[] } | { credentialKind: 'session' | 'pat'; credentialId: string } | { deviceTokenId: string }
  | { id: string; bindingId: string; ownerId: string; kind: ReviewSessionKind } | { leaseIds: readonly string[] }
export type ReviewRevokeReason = 'run_control' | 'run_changed' | 'task_changed' | 'credential_revoked'
  | 'membership_changed' | 'machine_changed' | 'expired'
type Database = Pick<Pool, 'query'>
type StoredLease = ReviewRevokeTarget & { id: string; kind: ReviewSessionKind; taskId: string; deviceId: string; repoId: string
  deviceTokenId: string; bindingId: string; machineEpoch: number; machineOperationId: string
  provider:'e2b' | 'cloudflare'; repositoryKey:string | null; reviewOperationId:string | null
  credentialKind: 'session' | 'pat'; credentialId: string; revokedAt: Date | null; expiresAt: Date }
const leaseView = (row: StoredLease): ReviewSessionLease => ({ id: row.id, expiresAt: row.expiresAt.toISOString(), ...(row.reviewOperationId ? {reviewOperationId:row.reviewOperationId, reviewKind:row.kind} : {}) })

/** This callback must run inside withTaskReviewAuthority, with its fresh
 * credential, Workspace/member, Task, Run and machine locks still held. A
 * reconnect reuses the original absolute expiry; it never renews the lease. */
export async function beginReviewSession(authority: TaskReviewAuthority,
  options: { kind: ReviewSessionKind; expiresAt?: string }, client: PoolClient): Promise<ReviewSessionLease> {
  if (authority.machineKind !== 'cloud' || !authority.sandboxId || authority.machineEpoch === null || !authority.machineOperationId)
    throw new ReviewAuthorityError('review_machine_gone')
  const { rows: [clock] } = await client.query<{ now: Date; state: string; runningSince: Date | null; computeSeconds: number | string }>(
    `SELECT clock_timestamp() AS now,state,"runningSince","computeSeconds" FROM thread_machines
      WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "sandboxId"=$4 AND epoch=$5 AND "operationId"=$6`,
  [authority.runId, authority.ownerId, authority.workspaceId, authority.sandboxId, authority.machineEpoch, authority.machineOperationId])
  if (!clock) throw new ReviewAuthorityError('review_machine_gone')
  const now = clock.now.getTime()
  const elapsed = clock.state === 'running' && clock.runningSince ? Math.max(0, now - clock.runningSince.getTime()) : 0
  const remaining = THREAD_MACHINE_BUDGET_MS - Number(clock.computeSeconds) * 1_000 - elapsed
  if (remaining <= 0) throw new ReviewAuthorityError('review_machine_gone')
  const deadline = Math.min(now + REVIEW_SESSION_MS, now + remaining, authority.credentialExpiresAt ? Date.parse(authority.credentialExpiresAt) : Infinity,
    options.expiresAt ? Date.parse(options.expiresAt) : Infinity)
  if (!Number.isFinite(deadline) || deadline <= now) throw new ReviewAuthorityError('review_auth_required')
  const { rows } = await client.query<StoredLease>('SELECT * FROM coding_review_sessions WHERE "runId"=$1 ORDER BY kind FOR UPDATE', [authority.runId])
  // A close pending on this exact run must ACK before another capability can
  // be minted. Otherwise a delayed revoke could close a replacement session.
  if (rows.some(row => row.revokedAt || row.expiresAt.getTime() <= now)) throw new ReviewAuthorityError('review_binding_changed')
  const placement = authority.sponsoredPlacement
  if (rows.some(row => row.provider !== (placement ? 'cloudflare' : 'e2b') ||
      (placement && (row.repositoryKey !== placement.repositoryKey || !row.reviewOperationId))))
    throw new ReviewAuthorityError('review_binding_changed')
  const current = rows.find(row => row.kind === options.kind)
  if (current) {
    if (current.bindingId !== authority.bindingId || current.credentialKind !== authority.credential.kind
      || current.credentialId !== authority.credential.id || current.ownerId !== authority.ownerId
      || current.workspaceId !== authority.workspaceId) throw new ReviewAuthorityError('review_binding_changed')
    if (deadline < current.expiresAt.getTime()) {
      const shortened = await client.query<StoredLease>('UPDATE coding_review_sessions SET "expiresAt"=$2 WHERE id=$1 RETURNING *', [current.id, new Date(deadline)])
      armDueTimerAfterCommit(client, 'run-recovery')
      return leaseView(shortened.rows[0]!)
    }
    return leaseView(current)
  }
  const reviewOperationId = placement ? (rows[0]?.reviewOperationId ?? randomUUID()) : null
  const { rows: [created] } = await client.query<StoredLease>(`INSERT INTO coding_review_sessions
    (id,kind,"taskId","runId","ownerId","workspaceId","deviceId","repoId","deviceTokenId","bindingId","sandboxId",
      "machineEpoch","machineOperationId","credentialKind","credentialId","createdAt","expiresAt",provider,"repositoryKey","reviewOperationId")
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
  [randomUUID(), options.kind, authority.taskId, authority.runId, authority.ownerId, authority.workspaceId, authority.deviceId,
    authority.repoId, authority.deviceTokenId, authority.bindingId, authority.sandboxId, authority.machineEpoch,
    authority.machineOperationId, authority.credential.kind, authority.credential.id, clock.now, new Date(deadline),
    placement ? 'cloudflare' : 'e2b', placement?.repositoryKey ?? null, reviewOperationId])
  await client.query(`UPDATE thread_machines SET "lifecycleAt"=clock_timestamp(),lifecycle=lifecycle-'reconcileId'-'reconcileUntil'
    WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "sandboxId"=$4 AND epoch=$5`,
  [authority.runId, authority.ownerId, authority.workspaceId, authority.sandboxId, authority.machineEpoch])
  armDueTimerAfterCommit(client, 'run-recovery')
  return leaseView(created!)
}

/** Read only an already opened capability; input cannot create a PTY. The
 * caller performs fresh task authority once per input/open, never per chunk. */
export async function readReviewSession(authority: TaskReviewAuthority, options: { kind: ReviewSessionKind; id?: string },
  database?: Database): Promise<ReviewSessionLease | null> {
  const db = database ?? (await import('../db')).pool
  const { rows: [row] } = await db.query<StoredLease>(`SELECT * FROM coding_review_sessions
    WHERE "runId"=$1 AND kind=$2 AND "ownerId"=$3 AND "workspaceId"=$4 AND "bindingId"=$5
      AND "credentialKind"=$6 AND "credentialId"=$7 AND ($8::uuid IS NULL OR id=$8)
      AND "revokedAt" IS NULL AND "expiresAt">clock_timestamp()`,
  [authority.runId, options.kind, authority.ownerId, authority.workspaceId, authority.bindingId,
    authority.credential.kind, authority.credential.id, options.id ?? null])
  return row ? leaseView(row) : null
}

/** Call only after the matching gateway's close ACK, or before any capability
 * was issued. Network detach is not a close: the gateway owns its grace time. */
export async function closeReviewSession(authority: TaskReviewAuthority, options: { kind: ReviewSessionKind; id?: string }, database?: Database) {
  const db = database ?? (await import('../db')).pool
  if (authority.sponsoredPlacement) {
    const id = options.id ?? (await readReviewSession(authority, {kind:options.kind}, db))?.id
    if (!id) return
    const result = await revokeReviewSession(authority, {kind:options.kind,id}, db)
    if (result.pending) throw Error('Task review close unconfirmed')
    return
  }
  const { rows } = await db.query<{ id: string }>(`DELETE FROM coding_review_sessions
    WHERE "runId"=$1 AND kind=$2 AND "ownerId"=$3 AND "workspaceId"=$4 AND "bindingId"=$5
      AND "credentialKind"=$6 AND "credentialId"=$7 AND ($8::uuid IS NULL OR id=$8) RETURNING id`,
  [authority.runId, options.kind, authority.ownerId, authority.workspaceId, authority.bindingId,
    authority.credential.kind, authority.credential.id, options.id ?? null])
  if (rows.length) {
    await db.query('UPDATE thread_machines SET "lifecycleAt"=clock_timestamp(),lifecycle=lifecycle-\'reconcileId\'-\'reconcileUntil\' WHERE "runId"=$1 AND epoch=$2 AND "sandboxId"=$3',
      [authority.runId, authority.machineEpoch, authority.sandboxId])
    armDueTimerSoon('run-recovery')
  }
}

function targetWhere(target: ReviewSessionTarget): { where: string; values: unknown[] } {
  if ('runIds' in target) return { where: 's."runId"=ANY($1::uuid[])', values: [[...target.runIds]] }
  if ('leaseIds' in target) return { where: 's.id=ANY($1::uuid[])', values: [[...target.leaseIds]] }
  if ('userId' in target) return { where: 's."ownerId"=$1', values: [target.userId] }
  if ('workspaceId' in target) return { where: 's."workspaceId"=$1 AND ($2::text IS NULL OR s."ownerId"=$2)', values: [target.workspaceId, target.ownerId ?? null] }
  if ('taskId' in target) return { where: 's."taskId"=$1', values: [target.taskId] }
  if ('taskIds' in target) return { where: 's."taskId"=ANY($1::uuid[])', values: [[...target.taskIds]] }
  if ('deviceTokenId' in target) return { where: 's."deviceTokenId"=$1', values: [target.deviceTokenId] }
  if ('id' in target) return { where: 's.id=$1 AND s."bindingId"=$2 AND s."ownerId"=$3 AND s.kind=$4', values: [target.id, target.bindingId, target.ownerId, target.kind] }
  return { where: 's."credentialKind"=$1 AND s."credentialId"=$2', values: [target.credentialKind, target.credentialId] }
}

/** Injectable only for isolated control-plane tests; the default remote close
 * tombstones these exact lease IDs before closing PTY/HTTP/WS and returning. */
export const reviewSessionTransport = {
  close: async (target: ReviewRevokeTarget, leaseIds: string[], expiresAt: string, kind: ReviewSessionKind) => {
    if (target.sponsored) return (await import('./cloudflare-review')).revokeCloudflareReview({ ...target, ...target.sponsored }, kind, leaseIds)
    if (kind === 'terminal') await (await import('./terminal/runtime')).revokeRunTerminal(target, { leaseIds, expiresAt })
    else await (await import('./preview/runtime')).revokeRunPreview(target, { leaseIds, expiresAt })
  },
}

async function closeRevoked(database: Database, rows: StoredLease[]) {
  const groups = new Map<string, StoredLease[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.runId, row.ownerId, row.workspaceId, row.sandboxId, row.kind, row.provider, row.reviewOperationId])
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group)
  }
  let closed = 0
  const closeGroup = async (group: StoredLease[]) => {
    const first = group[0]!, ids = group.map(row => row.id)
    const target: ReviewRevokeTarget = { runId: first.runId, ownerId: first.ownerId, workspaceId: first.workspaceId, sandboxId: first.sandboxId }
    try {
      if (first.provider === 'cloudflare') {
        if (!first.reviewOperationId || !first.repositoryKey) throw Error('Missing persisted Cloudflare review placement')
        target.sponsored = {taskId:first.taskId, repositoryKey:first.repositoryKey, operationId:first.reviewOperationId}
      }
      const receipt = await reviewSessionTransport.close(target, ids, new Date(Math.max(...group.map(row => row.expiresAt.getTime()))).toISOString(), first.kind)
      if (receipt) {
        await database.query(`UPDATE thread_machines SET state='paused',"runningSince"=NULL,"computeSeconds"="computeSeconds"+
          CASE WHEN "runningSince" IS NULL THEN 0 ELSE GREATEST(0,ceil(extract(epoch FROM clock_timestamp()-"runningSince")))::integer END,
          lifecycle=(lifecycle-'sponsoredPreparedCheckpoint')||jsonb_strip_nulls(jsonb_build_object('phase','paused','sponsoredPreparedCheckpoint',$7::jsonb)),
          "lifecycleAt"=clock_timestamp() WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "sandboxId"=$4 AND epoch=$5 AND "operationId"=$6`,
        [first.runId, first.ownerId, first.workspaceId, first.sandboxId, first.machineEpoch, first.machineOperationId, JSON.stringify(receipt.checkpoint ?? null)])
      }
      await database.query('DELETE FROM coding_review_sessions WHERE id=ANY($1::uuid[]) AND "revokedAt" IS NOT NULL', [ids])
      await database.query('UPDATE thread_machines SET "lifecycleAt"=clock_timestamp(),lifecycle=lifecycle-\'reconcileId\'-\'reconcileUntil\' WHERE "runId"=$1 AND epoch=$2 AND "sandboxId"=$3',
        [first.runId, first.machineEpoch, first.sandboxId])
      closed += group.length
    } catch {
      await database.query('UPDATE coding_review_sessions SET "retryAt"=clock_timestamp()+interval \'15 seconds\' WHERE id=ANY($1::uuid[]) AND "revokedAt" IS NOT NULL', [ids])
      console.warn('Review capability close deferred', { code: 'review_close_unacknowledged' })
    }
  }
  // Bound fan-out while closing both kinds of an affected run concurrently.
  const queued = [...groups.values()]
  for (let offset = 0; offset < queued.length; offset += 4) await Promise.all(queued.slice(offset, offset + 4).map(closeGroup))
  if (rows.length) armDueTimerSoon('run-recovery')
  return { closed, pending: rows.length - closed }
}

async function markRevokedRows(database: Database, target: ReviewSessionTarget, reason: ReviewRevokeReason) {
  const { where, values } = targetWhere(target)
  const { rows } = await database.query<StoredLease>(`WITH affected AS MATERIALIZED (
      SELECT DISTINCT s."runId" FROM coding_review_sessions s WHERE ${where}),
    locked AS MATERIALIZED (SELECT m."runId" FROM thread_machines m JOIN affected a ON a."runId"=m."runId"
      ORDER BY m."runId" FOR UPDATE OF m),
    invalidated AS (UPDATE thread_machines m SET "lifecycleAt"=clock_timestamp(),lifecycle=m.lifecycle-'reconcileId'-'reconcileUntil'
      WHERE m."runId" IN (SELECT "runId" FROM locked) RETURNING m."runId")
    UPDATE coding_review_sessions s SET "revokedAt"=COALESCE(s."revokedAt",clock_timestamp()),reason=$${values.length + 1},"retryAt"=clock_timestamp()
    WHERE (${where}) AND s."runId" IN (SELECT "runId" FROM invalidated UNION ALL SELECT a."runId" FROM affected a
      WHERE NOT EXISTS(SELECT 1 FROM thread_machines m WHERE m."runId"=a."runId")) RETURNING s.*`, [...values, reason])
  return rows
}

/** Cross-database scope writers hold the existing Workspace relation lock.
 * Fence in APP now, but capture only exact IDs: provider IO must wait until
 * the outer Workspace transaction has committed or rolled back. */
export async function markReviewSessionsRevoked(database: Database, target: ReviewSessionTarget, reason: ReviewRevokeReason) {
  return (await markRevokedRows(database, target, reason)).map(row => row.id)
}

/** Drain only previously fenced IDs after all outer SQL locks are released.
 * A new legitimate grant after that commit has another ID and is untouched.
 * Even a failed scope write leaves its durable fence due for cleanup. */
export async function drainRevokedReviewSessions(database: Database, leaseIds: readonly string[]) {
  if (!leaseIds.length) return { closed: 0, pending: 0 }
  try {
    const { rows } = await database.query<StoredLease>('SELECT * FROM coding_review_sessions WHERE id=ANY($1::uuid[]) AND "revokedAt" IS NOT NULL', [[...leaseIds]])
    return await closeRevoked(database, rows)
  } catch {
    armDueTimerSoon('run-recovery')
    console.warn('Review capability close deferred', { code: 'review_close_unacknowledged' })
    return { closed: 0, pending: leaseIds.length }
  }
}

/** A committed stop/policy/revoke fences both run capabilities. The machine
 * row serializes against begin's authorization callback, then remote IO runs
 * outside SQL locks. Closed rows remain until both data planes acknowledge. */
export async function revokeReviewSessions(database: Database, target: ReviewSessionTarget, reason: ReviewRevokeReason) {
  return closeRevoked(database, await markRevokedRows(database, target, reason))
}

/** Error cleanup and an explicit user close share one durable close protocol.
 * A frozen old authority may close only its exact opaque lease, never acquire
 * a capability. Do not require fresh authority after a scope change to clean up. */
export async function revokeReviewSession(authority: TaskReviewAuthority, options: { kind: ReviewSessionKind; id: string }, database?: Database) {
  const db = database ?? (await import('../db')).pool
  return revokeReviewSessions(db, { id: options.id, bindingId: authority.bindingId, ownerId: authority.ownerId, kind: options.kind }, 'run_control')
}

/** The caller already holds the source/machine transaction lock. Persist the
 * fence now; provider IO is deferred until COMMIT and never holds SQL locks. */
export async function fenceReviewSessions(client: PoolClient, target: ReviewSessionTarget, reason: ReviewRevokeReason) {
  const { where, values } = targetWhere(target)
  await client.query(`UPDATE coding_review_sessions s SET "revokedAt"=COALESCE("revokedAt",clock_timestamp()),
    reason=$${values.length + 1},"retryAt"=clock_timestamp() WHERE ${where}`, [...values, reason])
  armDueTimerAfterCommit(client, 'run-recovery')
  reviewSessionsRevoked(client, target, reason)
}

/** Semantic writes invalidate changed bindings. Successful/failed completion
 * alone is allowed to retain a human lease; stop/closure/loss always wins. */
export async function reconcileReviewSessions(database: Database, target: ReviewSessionTarget) {
  const { where, values } = targetWhere(target)
  const { rows } = await database.query<{ id: string }>(`SELECT s.id FROM coding_review_sessions s
    LEFT JOIN agent_runs r ON r.id=s."runId" LEFT JOIN issues i ON i.id=s."taskId"
    LEFT JOIN devices d ON d.id=s."deviceId" LEFT JOIN thread_machines m ON m."runId"=s."runId"
    WHERE (${where}) AND (s."revokedAt" IS NOT NULL OR s."expiresAt"<=clock_timestamp()
      OR r.id IS NULL OR r."userId"<>s."ownerId" OR r."issueId" IS DISTINCT FROM s."taskId"
      OR NOT (${taskThreadRunPredicate('r')})
      OR r."workspaceId" IS DISTINCT FROM s."workspaceId"
      OR r."deviceId" IS DISTINCT FROM s."deviceId" OR r."deviceRepoId" IS DISTINCT FROM s."repoId"
      OR r."deviceTokenId" IS DISTINCT FROM s."deviceTokenId" OR r."stopRequestedAt" IS NOT NULL
      OR r.status IN ('stopped','cancelled') OR r."stopReason"='device_lost'
      OR (r.status IN ('preparing','running','waiting_input','finishing') AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt"<=clock_timestamp()))
      OR i.id IS NULL OR i.status IN ('done','canceled','duplicate')
      OR i."ownershipState" IS DISTINCT FROM 'bound' OR i."workspaceId" IS DISTINCT FROM s."workspaceId"
      OR coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->>'deletedAt' IS NOT NULL
      OR CASE WHEN coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->'assignee'->>'kind'='member'
        THEN coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->'assignee'->>'id' ELSE i."userId" END IS DISTINCT FROM s."ownerId"
      OR d.id IS NULL OR d."ownerId"<>s."ownerId" OR d.enabled=false OR d."removedAt" IS NOT NULL
      OR m."runId" IS NULL OR m.state='ended' OR m."ownerId"<>s."ownerId" OR m."workspaceId"<>s."workspaceId"
      OR m."issueId" IS DISTINCT FROM s."taskId" OR m."deviceId" IS DISTINCT FROM s."deviceId"
      OR m."sandboxId" IS DISTINCT FROM s."sandboxId" OR m.epoch<>s."machineEpoch" OR m."operationId"<>s."machineOperationId"
      OR EXISTS(SELECT 1 FROM agent_runs newer WHERE newer."issueId"=s."taskId" AND ${taskThreadRunPredicate('newer')}
        AND (newer."createdAt",newer.id)>(r."createdAt",r.id))
      OR (s."credentialKind"='session' AND NOT EXISTS(SELECT 1 FROM "session" c WHERE c.id=s."credentialId" AND c."userId"=s."ownerId" AND c."expiresAt">clock_timestamp()))
      OR (s."credentialKind"='pat' AND NOT EXISTS(SELECT 1 FROM personal_access_tokens c WHERE c.id::text=s."credentialId" AND c."userId"=s."ownerId"
        AND c."workspaceId"=s."workspaceId" AND c."revokedAt" IS NULL AND (c."expiresAt" IS NULL OR c."expiresAt">clock_timestamp()))))`, values)
  if (rows.length) return revokeReviewSessions(database, { leaseIds: rows.map(row => row.id) }, 'run_changed')
  return { closed: 0, pending: 0 }
}

/** Expiry and failed close ACKs use the existing run-recovery due timer. */
export async function expireReviewSessions(database: Database) {
  const { rows } = await database.query<{ id: string }>(`SELECT id FROM coding_review_sessions
    WHERE COALESCE("retryAt","expiresAt")<=clock_timestamp() ORDER BY COALESCE("retryAt","expiresAt"),id LIMIT 50`)
  return rows.length ? revokeReviewSessions(database, { leaseIds: rows.map(row => row.id) }, 'expired') : { closed: 0, pending: 0 }
}

export function reviewSessionsChanged(executor: object, target: ReviewSessionTarget, outerCommit?: object) {
  try {
    const key = `review-authority:${JSON.stringify(target)}`
    const schedule = async () => {
      const [{ pool, withoutDatabaseClient }, { afterJob }] = await Promise.all([import('../db/request-scope'), import('../background')])
      afterJob('after:device-wake', () => withoutDatabaseClient(() => reconcileReviewSessions(pool, target)), { orRun: true })
    }
    afterDatabaseCommit(executor, key, () => {
      if (outerCommit) afterDatabaseCommit(outerCommit, key, schedule)
      else return schedule()
    })
  } catch { console.warn('Review reconciliation wake unavailable', { code: 'review_commit_observation_unavailable' }) }
}

/** Factory binding's SQL trigger already fences this exact checker's leases.
 * APP rollback sends nothing. If a surrounding Workspace transaction exists,
 * capture its executor now and schedule remote close only after its COMMIT.
 * A failed outer transaction leaves the durable row for the existing due timer. */
export async function reviewRunBecameChecker(executor: object, runId: string) {
  const { workspacePool } = await import('../workspace-db')
  reviewSessionsChanged(executor, { runIds: [runId] }, captureDatabaseQuery(workspacePool))
}

/** Explicit security/control mutations already know they removed authority;
 * never route ordinary output, status or title notifications through here. */
export function reviewSessionsRevoked(executor: object, target: ReviewSessionTarget, reason: ReviewRevokeReason) {
  try {
    afterDatabaseCommit(executor, `review-revoke:${JSON.stringify(target)}`, async () => {
      const [{ pool, withoutDatabaseClient }, { afterJob }] = await Promise.all([import('../db/request-scope'), import('../background')])
      afterJob('after:device-wake', () => withoutDatabaseClient(() => revokeReviewSessions(pool, target, reason)), { orRun: true })
    })
  } catch { console.warn('Review revocation wake unavailable', { code: 'review_commit_observation_unavailable' }) }
}

type ReviewTaskSnapshot = { id: string; userId: string; status: string; scope?: string; workspaceId?: string | null; ownershipState?: string; content: Parameters<typeof readIssueMetadata>[0] }
/** A cheap in-memory comparison at actual task writers, not the live output
 * path. Renaming or editing prose performs no additional review SQL. */
export function reviewTaskChanged(executor: object, before: ReviewTaskSnapshot, after: ReviewTaskSnapshot) {
  const prior = readIssueMetadata(before.content), next = readIssueMetadata(after.content)
  const previousOwner = prior.assignee?.kind === 'member' ? prior.assignee.id : before.userId
  const nextOwner = next.assignee?.kind === 'member' ? next.assignee.id : after.userId
  if (previousOwner !== nextOwner || before.userId !== after.userId || before.scope !== after.scope
    || before.workspaceId !== after.workspaceId || before.ownershipState !== after.ownershipState
    || prior.deletedAt !== next.deletedAt || before.status !== after.status && ['done', 'canceled', 'duplicate'].includes(after.status))
    reviewSessionsRevoked(executor, { taskId: after.id }, 'task_changed')
}
