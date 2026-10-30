import 'server-only'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { queueFactoryRun } from '@/lib/agent-runs'
import type { CiContinuation } from '@/lib/ci-continuation-contract'

export type CiFollowUp = Omit<CiContinuation, 'originSessionId' | 'requireSessionResume'>
class ContinuationUnavailable extends Error { constructor() { super('CI original-session continuation unavailable') } }
const unavailable = (): never => { throw new ContinuationUnavailable() }
const same = (a: CiContinuation | null | undefined, b: CiContinuation) => Boolean(a && Object.keys(b).every(key => a[key as keyof CiContinuation] === b[key as keyof CiContinuation]) && Object.keys(a).length === Object.keys(b).length)
const valid = (c: CiFollowUp) => /^[a-f0-9]{40}$/i.test(c.head) && /^[a-f0-9]{64}$/i.test(c.fingerprint) && Number.isSafeInteger(c.prNumber) && c.prNumber > 0 && Number.isSafeInteger(c.scopeVersion) && c.scopeVersion > 0 && typeof c.followUp === 'string' && c.followUp.trim().length > 0 && c.followUp.length <= 4000

/** Called only by CI reconciler in its transaction, holding the observation lock. */
export async function queueCiContinuation(tx: PoolClient, userId: string, input: CiFollowUp) {
  if (!valid(input)) unavailable()
  const { rows: [binding] } = await tx.query(`SELECT o.*, r."sessionId", r."agentId", r."deviceId", r."deviceRepoId", r."botId", r.status AS "runStatus", r."stopReason", r."stopRequestedAt", r."agentDefinition", r."ciContinuation", p."pullRequest"
    FROM github_ci_observations o JOIN agent_runs r ON r.id=o."originRunId" AND r."userId"=o."userId" AND r."issueId"=o."issueId"
    JOIN run_publications p ON p."runId"=r.id AND p."userId"=o."userId" AND p."issueId"=o."issueId" AND p."remoteKey"=o."remoteKey"
    JOIN issues i ON i.id=o."issueId" AND i."scopeVersion"=o."scopeVersion"
    WHERE o."userId"=$1 AND o."issueId"=$2 AND o."remoteKey"=$3 AND o."prNumber"=$4 AND o."originRunId"=$5 AND o."scopeVersion"=$6
      AND o.head=$7 AND o.fingerprint=$8 AND o."expiresAt">now() AND p.status='published'
      AND NOT EXISTS (SELECT 1 FROM improvement_skill_selections sel WHERE sel."runId"=r.id) FOR UPDATE OF o`,
  [userId, input.issueId, input.remoteKey, input.prNumber, input.originRunId, input.scopeVersion, input.head, input.fingerprint])
  if (!binding || !binding.sessionId || typeof binding.sessionId !== 'string' || binding.sessionId.length > 500 || !binding.agentId || !binding.deviceId || !binding.deviceRepoId || binding.stopRequestedAt || !['succeeded', 'stopped'].includes(binding.runStatus) || binding.stopReason !== 'submitted' || !binding.agentDefinition?.definitionDigest || binding.agentDefinition.subscription || !['open', 'draft'].includes(binding.pullRequest?.state)) unavailable()
  const key = `ci:${createHash('sha256').update(JSON.stringify([userId, input.issueId, input.remoteKey, input.prNumber, input.head, input.fingerprint, binding.watchId, String(binding.generation)])).digest('hex')}`
  const queued = await queueFactoryRun(tx, userId, { issueId: input.issueId, agentId: binding.agentId, deviceRepoId: binding.deviceRepoId, note: input.followUp, requestKey: key }, binding.botId, undefined, input.originRunId)
  const { rows: [child] } = await tx.query('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [queued.runId, userId])
  if (!child || child.status !== 'queued' || child.deviceId !== binding.deviceId || child.agentId !== binding.agentId || child.deviceRepoId !== binding.deviceRepoId || child.botId !== binding.botId || child.agentDefinition?.definitionDigest !== binding.agentDefinition.definitionDigest) unavailable()
  const continuation: CiContinuation = { ...input, originSessionId: binding.sessionId, requireSessionResume: true }
  if (child.ciContinuation && !same(child.ciContinuation, continuation)) unavailable()
  if (!child.ciContinuation) await tx.query('UPDATE agent_runs SET "ciContinuation"=$2 WHERE id=$1', [queued.runId, JSON.stringify(continuation)])
  return queued
}

/** Claim-time check against this watch's database state only; there is no
 * second GitHub read. Reconcile already read GitHub (with the person's access)
 * before queueing, and every later webhook or poll that changes the head or the
 * stable result either retires this run or changes the watch, which makes it
 * stale here. A run that is stale is retired; no model is invoked. */
export type CiPreflight = { kind: 'valid'; generation: string } | { kind: 'stale'; generation: string | null }
export async function preflightCiClaim(userId: string, c: CiContinuation): Promise<CiPreflight> {
  const { rows: [o] } = await pool.query(`SELECT generation,head,fingerprint,"originRunId","expiresAt">now() AS active FROM github_ci_observations WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4`, [userId, c.issueId, c.remoteKey, c.prNumber])
  const generation = o ? String(o.generation) : null
  if (!o || !valid(c) || !c.originSessionId || c.requireSessionResume !== true || !o.active || o.originRunId !== c.originRunId || o.head !== c.head || o.fingerprint !== c.fingerprint) return { kind: 'stale', generation }
  return { kind: 'valid', generation: String(o.generation) }
}

/** Retry only database deadlocks/serialization failures, after rollback. */
async function ciTransaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const result = await operation(tx)
      await tx.query('COMMIT')
      return result
    } catch (error) {
      await tx.query('ROLLBACK')
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
    } finally { tx.release() }
  }
}

/** Clear only the exact unclaimed CI result whose provider snapshot is stale. */
export async function retireStaleCiRun(userId: string, runId: string, expected: CiContinuation, generation: string | null) {
  return ciTransaction(async tx => {
    await tx.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [expected.issueId])
    const { rows: [observation] } = await tx.query('SELECT generation FROM github_ci_observations WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 FOR UPDATE', [userId, expected.issueId, expected.remoteKey, expected.prNumber])
    if ((observation ? String(observation.generation) : null) !== generation) return false
    const result = await tx.query(`UPDATE agent_runs SET status='stopped',"stopReason"='superseded',error='CI result changed before the follow-up started.',"finishedAt"=now(),"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND status='queued' AND "stopRequestedAt" IS NULL AND "ciContinuation"=$3::jsonb RETURNING id`, [runId, userId, JSON.stringify(expected)])
    if (result.rowCount) await releaseCiResumes(tx, [runId])
    if (result.rowCount && observation) await tx.query(`UPDATE github_ci_observations SET "nextCheckAt"=now(),generation=generation+1,"updatedAt"=now() WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4`, [userId, expected.issueId, expected.remoteKey, expected.prNumber])
    return Boolean(result.rowCount)
  })
}

/** Under the claim transaction: recheck identity, current scope and event fence. */
export async function guardCiClaim(tx: PoolClient, userId: string, deviceId: string, runId: string, expected: CiContinuation, generation: string) {
  const { rows: [row] } = await tx.query(`SELECT r."ciContinuation", r."agentId", r."deviceRepoId", r."botId", r."deviceId", r.status, r."stopRequestedAt", r."agentDefinition", origin."sessionId", origin."agentId" AS "originAgentId", origin."deviceId" AS "originDeviceId", origin."deviceRepoId" AS "originRepoId", origin."botId" AS "originBotId", origin."stopRequestedAt" AS "originStop", origin."agentDefinition" AS "originDefinition"
    FROM agent_runs r JOIN agent_runs origin ON origin.id=$3 AND origin."userId"=$2 AND origin."issueId"=$4
    JOIN issues i ON i.id=$4 AND i."scopeVersion"=$5
    JOIN github_ci_observations o ON o."userId"=$2 AND o."issueId"=$4 AND o."remoteKey"=$6 AND o."prNumber"=$7 AND o."originRunId"=origin.id AND o."scopeVersion"=$5
    WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$4 AND o.head=$8 AND o.fingerprint=$9 AND o."expiresAt">now() AND o.generation=$10::bigint
    FOR UPDATE OF i,r,o FOR SHARE OF origin`, [runId, userId, expected.originRunId, expected.issueId, expected.scopeVersion, expected.remoteKey, expected.prNumber, expected.head, expected.fingerprint, generation])
  if (!row || !same(row.ciContinuation, expected) || row.status !== 'queued' || row.stopRequestedAt || row.originStop || row.deviceId !== deviceId || row.originDeviceId !== deviceId || row.agentId !== row.originAgentId || row.deviceRepoId !== row.originRepoId || row.botId !== row.originBotId || row.sessionId !== expected.originSessionId || !row.agentDefinition || row.agentDefinition.definitionDigest !== row.originDefinition?.definitionDigest) return null
  return { continuesRunId: expected.originRunId, resumeSessionId: expected.originSessionId, followUp: expected.followUp, requireSessionResume: true as const, preserveQuestionWorktree: true as const }
}

/** No assignment bytes were returned. Revoke its provisional token and make
 * the same run claimable again; preflight will re-read GitHub before retry. */
export async function retryUnsentCiClaim(userId: string, runId: string, expected: CiContinuation, leaseExpiresAt: string) {
  return ciTransaction(async tx => {
    await tx.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [expected.issueId])
    const { rows: [run] } = await tx.query('SELECT status,"stopRequestedAt","ciContinuation","leaseExpiresAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, userId])
    if (!run || run.status !== 'preparing' || run.stopRequestedAt || !same(run.ciContinuation, expected) || !(run.leaseExpiresAt instanceof Date) || run.leaseExpiresAt.toISOString() !== leaseExpiresAt) return false
    await tx.query('UPDATE run_tokens SET "revokedAt"=now() WHERE "runId"=$1 AND "userId"=$2 AND "revokedAt" IS NULL', [runId, userId])
    await tx.query("UPDATE agent_runs SET status='queued',\"updatedAt\"=now() WHERE id=$1", [runId])
    return true
  })
}

/** The caller holds the PR observation lock and has read its current provider
 * state. Revoke only undelivered queued runs for the same task/PR when their
 * saved head or complete snapshot is superseded. */
export async function retireSupersededCiRuns(tx: PoolClient, userId: string, current: { issueId: string; remoteKey: string; prNumber: number; head: string | null; fingerprint: string | null }) {
  await tx.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [current.issueId])
  const result = await tx.query(`UPDATE agent_runs SET status='stopped',"stopReason"='superseded',error='CI result changed before the follow-up started.',"finishedAt"=now(),"updatedAt"=now()
    WHERE "userId"=$1 AND "issueId"=$2 AND status='queued' AND "stopRequestedAt" IS NULL
      AND "ciContinuation"->>'remoteKey'=$3 AND "ciContinuation"->>'prNumber'=$4
      AND ("ciContinuation"->>'head' IS DISTINCT FROM $5 OR ($6::text IS NOT NULL AND "ciContinuation"->>'fingerprint' IS DISTINCT FROM $6))
    RETURNING id`, [userId, current.issueId, current.remoteKey, String(current.prNumber), current.head, current.fingerprint])
  if (result.rowCount) await releaseCiResumes(tx, result.rows.map(row => row.id))
  return result.rowCount ?? 0
}

/** A retired follow-up was never claimed, so it spent no model call: give its
 * resume budget back (lib/github/ci/budget.ts). */
async function releaseCiResumes(tx: PoolClient, runIds: string[]) {
  await tx.query('DELETE FROM github_ci_resumes WHERE "runId" = ANY($1)', [runIds])
}

/** Kill switch at claim: with MIKKA_CI_RESUME_ENABLED off, an already-queued CI
 * follow-up is stopped instead of reaching a model. Its budget row is kept. */
export async function retireDisabledCiRun(userId: string, runId: string) {
  const result = await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='superseded',error='CI resume is disabled.',"finishedAt"=now(),"updatedAt"=now()
    WHERE id=$1 AND "userId"=$2 AND status='queued' AND "stopRequestedAt" IS NULL AND "ciContinuation" IS NOT NULL RETURNING id`, [runId, userId])
  return Boolean(result.rowCount)
}
