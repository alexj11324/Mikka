import 'server-only'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { queueFactoryRun } from '@/lib/agent-runs'
import { CiContinuationUnsupported, type CiContinuation } from '@/lib/ci-continuation-contract'
import { readCi } from '@/lib/github/ci/read'
import { summarize } from '@/lib/github/ci/snapshot'
import { listCiWorkflowAttempts } from '@/lib/github/ci/attempts'
import { verifyGitHubRepositoryAccess } from '@/lib/github/run-pull-request'
import { linkedGitHubAccountId } from '@/lib/github/repository-installation'
import { currentCiSubscriptionAuthorized } from '@/lib/ci-subscription-authority'
import { currentContinuationMailboxAuthorized } from '@/lib/ci-mailbox-continuation'

export type CiFollowUp = Omit<CiContinuation, 'originSessionId' | 'requireSessionResume'>
class ContinuationUnavailable extends Error { constructor() { super('CI original-session continuation unavailable') } }
const unavailable = (): never => { throw new ContinuationUnavailable() }
const same = (a: CiContinuation | null | undefined, b: CiContinuation) => Boolean(a && Object.keys(b).every(key => a[key as keyof CiContinuation] === b[key as keyof CiContinuation]) && Object.keys(a).length === Object.keys(b).length)
const valid = (c: CiFollowUp) => /^[a-f0-9]{40}$/i.test(c.head) && /^[a-f0-9]{64}$/i.test(c.fingerprint) && Number.isSafeInteger(c.prNumber) && c.prNumber > 0 && Number.isSafeInteger(c.scopeVersion) && c.scopeVersion > 0 && typeof c.followUp === 'string' && c.followUp.trim().length > 0 && c.followUp.length <= 4000

/** Called only by CI reconciler in its transaction, holding the observation lock. */
export async function queueCiContinuation(tx: PoolClient, userId: string, input: CiFollowUp) {
  if (!valid(input)) unavailable()
  const { rows: [binding] } = await tx.query(`SELECT o.*, r."sessionId", r."agentId", r."deviceId", r."deviceRepoId", r."botId", r.status AS "runStatus", r."stopReason", r."stopRequestedAt", r."agentDefinition", r."ciContinuation", p."pullRequest", EXISTS (SELECT 1 FROM improvement_skill_selections sel WHERE sel."runId"=r.id) AS "skillSelected"
    FROM github_ci_observations o JOIN agent_runs r ON r.id=o."originRunId" AND r."userId"=o."userId" AND r."issueId"=o."issueId"
    JOIN run_publications p ON p."runId"=r.id AND p."userId"=o."userId" AND p."issueId"=o."issueId" AND p."remoteKey"=o."remoteKey"
    JOIN issues i ON i.id=o."issueId" AND i."scopeVersion"=o."scopeVersion"
    WHERE o."userId"=$1 AND o."issueId"=$2 AND o."remoteKey"=$3 AND o."prNumber"=$4 AND o."originRunId"=$5 AND o."scopeVersion"=$6
      AND o.head=$7 AND o.fingerprint=$8 AND o."expiresAt">now() AND p.status='published'
      FOR UPDATE OF o`,
  [userId, input.issueId, input.remoteKey, input.prNumber, input.originRunId, input.scopeVersion, input.head, input.fingerprint])
  if (!binding || !binding.agentId || !binding.deviceId || !binding.deviceRepoId || binding.stopRequestedAt || !['succeeded', 'stopped'].includes(binding.runStatus) || binding.stopReason !== 'submitted' || !['open', 'draft'].includes(binding.pullRequest?.state)) unavailable()
  if (!binding.sessionId || typeof binding.sessionId !== 'string' || binding.sessionId.length > 500) throw new CiContinuationUnsupported('session_missing')
  if (!binding.agentDefinition?.definitionDigest) throw new CiContinuationUnsupported('definition_missing')
  if (binding.agentDefinition?.subscription) {
    // Missing, oversized or failed snapshots must produce a durable attention
    // event rather than silently enqueueing an impossible hosted resume.
    const snapshot = await tx.query('SELECT 1 FROM ci_native_sessions WHERE "runId"=$1', [input.originRunId])
    if (!snapshot.rowCount) throw new CiContinuationUnsupported('session_missing')
  }
  const key = `ci:${createHash('sha256').update(JSON.stringify([userId, input.issueId, input.remoteKey, input.prNumber, input.head, input.fingerprint, binding.watchId, String(binding.generation)])).digest('hex')}`
  // An unsupported skill or revoked mailbox may be reported to the user by
  // the caller. Roll back the child before turning it into a recoverable notice.
  await tx.query('SAVEPOINT ci_continuation_admission')
  try {
    const queued = await queueFactoryRun(tx, userId, { issueId: input.issueId, agentId: binding.agentId, deviceRepoId: binding.deviceRepoId, note: input.followUp, requestKey: key }, binding.botId, undefined, input.originRunId, true)
    const { rows: [child] } = await tx.query('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [queued.runId, userId])
    if (!child || child.status !== 'queued' || child.deviceId !== binding.deviceId || child.agentId !== binding.agentId || child.deviceRepoId !== binding.deviceRepoId || child.botId !== binding.botId) unavailable()
    if (child.agentDefinition?.definitionDigest !== binding.agentDefinition.definitionDigest) throw new CiContinuationUnsupported('definition_changed')
    const continuation: CiContinuation = { ...input, originSessionId: binding.sessionId, requireSessionResume: true }
    if (child.ciContinuation && !same(child.ciContinuation, continuation)) unavailable()
    if (!child.ciContinuation) await tx.query('UPDATE agent_runs SET "ciContinuation"=$2 WHERE id=$1', [queued.runId, JSON.stringify(continuation)])
    if (binding.skillSelected) {
      try { await (await import('@/lib/self-improvement/server')).skillAssignments.continueCi(userId, queued.runId, tx) }
      catch (error) {
        const { ImprovementError } = await import('@/lib/self-improvement/contract')
        if (error instanceof ImprovementError) throw new CiContinuationUnsupported('skill')
        throw error
      }
    }
    await tx.query('RELEASE SAVEPOINT ci_continuation_admission')
    return queued
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT ci_continuation_admission')
    await tx.query('RELEASE SAVEPOINT ci_continuation_admission')
    throw error
  }
}

/** Fresh provider check before claiming; no model is invoked. */
export type CiPreflight = { kind: 'valid'; generation: string } | { kind: 'stale'; generation: string | null } | { kind: 'unavailable' }
export async function preflightCiClaim(userId: string, c: CiContinuation): Promise<CiPreflight> {
  if (!valid(c) || !c.originSessionId || c.requireSessionResume !== true) return { kind: 'unavailable' }
  const { rows: [binding] } = await pool.query(`SELECT g."installationId",g."repositoryId",p.branch,o.generation,o.head,o.fingerprint,o."originRunId",o."expiresAt" FROM github_repository_installations g JOIN run_publications p ON p."userId"=g."userId" AND p."remoteKey"=g."remoteKey" LEFT JOIN github_ci_observations o ON o."userId"=p."userId" AND o."issueId"=p."issueId" AND o."remoteKey"=p."remoteKey" AND o."prNumber"=$5 WHERE g."userId"=$1 AND g."remoteKey"=$2 AND p."runId"=$3 AND p."issueId"=$4`, [userId, c.remoteKey, c.originRunId, c.issueId, c.prNumber])
  if (!binding?.branch || (binding.generation !== null && !/^\d+$/.test(String(binding.generation)))) return { kind: 'unavailable' }
  const generation = binding.generation === null ? null : String(binding.generation)
  try {
    const signal = AbortSignal.timeout(20_000)
    const access = await verifyGitHubRepositoryAccess({ remoteKey: c.remoteKey, githubAccountId: await linkedGitHubAccountId(userId), fetcher: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) })
    if (access.installationId !== Number(binding.installationId) || access.repositoryId !== Number(binding.repositoryId)) return { kind: 'unavailable' }
    const result = await readCi({ remoteKey: c.remoteKey, installationId: Number(binding.installationId), repositoryId: Number(binding.repositoryId), prNumber: c.prNumber, branch: binding.branch }, process.env, fetch, { deadline: Date.now() + 20_000 })
    const attempts = process.env.MIKKA_CI_EXTERNAL_POLLING === '1' ? [] : await listCiWorkflowAttempts(pool, { userId, issueId: c.issueId, remoteKey: c.remoteKey, prNumber: c.prNumber, head: c.head })
    const summary = summarize(result.snapshot, attempts)
    if (!result.open || result.head !== c.head) return { kind: 'stale', generation }
    if (summary.kind !== 'complete') return { kind: 'unavailable' }
    if (summary.fingerprint !== c.fingerprint) return { kind: 'stale', generation }
    if (generation === null || binding.originRunId !== c.originRunId || (binding.expiresAt instanceof Date && binding.expiresAt.getTime() <= Date.now()) || (binding.head && binding.head !== c.head) || (binding.fingerprint && binding.fingerprint !== c.fingerprint)) return { kind: 'stale', generation }
    return binding.head === c.head && binding.fingerprint === c.fingerprint ? { kind: 'valid', generation } : { kind: 'unavailable' }
  } catch { return { kind: 'unavailable' } }
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
    if (result.rowCount && observation) await tx.query(`UPDATE github_ci_observations SET "deliveredFingerprint"=CASE WHEN "deliveredFingerprint"=$5 THEN NULL ELSE "deliveredFingerprint" END, "nextCheckAt"=now(),generation=generation+1,"updatedAt"=now() WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4`, [userId, expected.issueId, expected.remoteKey, expected.prNumber, expected.fingerprint])
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
  if (!await currentCiSubscriptionAuthorized(tx, userId, row.agentId, row.agentDefinition)) return null
  if (!await currentContinuationMailboxAuthorized(tx, userId, row.botId, row.originDefinition, row.agentDefinition, process.env.MIKKA_PERSONAL_MAILBOX_ENABLED === '1')) throw new CiContinuationUnsupported('mailbox')
  return { continuesRunId: expected.originRunId, resumeSessionId: expected.originSessionId, followUp: expected.followUp, requireSessionResume: true as const, ciSessionResume: true as const, ciHead: expected.head, preserveQuestionWorktree: true as const }
}

/** A known mailbox revocation must not leave an unclaimable run occupying the
 * task. Revalidate with the same event fence before retiring; the observation
 * remains due so reconciliation can emit its durable attention event. */
export async function retireRevokedMailboxCiRun(userId: string, runId: string, expected: CiContinuation, generation: string) {
  return ciTransaction(async tx => {
    await tx.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [expected.issueId])
    const { rows: [observation] } = await tx.query(`SELECT generation,"originRunId" FROM github_ci_observations WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 FOR UPDATE`, [userId, expected.issueId, expected.remoteKey, expected.prNumber])
    if (!observation || String(observation.generation) !== generation || observation.originRunId !== expected.originRunId) return false
    const { rows: [run] } = await tx.query(`SELECT r."ciContinuation",r."botId",r."agentDefinition",origin."agentDefinition" AS "originDefinition" FROM agent_runs r JOIN agent_runs origin ON origin.id=$3 AND origin."userId"=$2 AND origin."issueId"=$4 WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$4 AND r.status='queued' AND r."stopRequestedAt" IS NULL FOR UPDATE OF r FOR SHARE OF origin`, [runId, userId, expected.originRunId, expected.issueId])
    if (!run || !same(run.ciContinuation, expected) || await currentContinuationMailboxAuthorized(tx, userId, run.botId, run.originDefinition, run.agentDefinition, process.env.MIKKA_PERSONAL_MAILBOX_ENABLED === '1')) return false
    const updated = await tx.query(`UPDATE agent_runs SET status='stopped',"stopReason"='blocked',error='CI follow-up mailbox authorization was revoked.',"finishedAt"=now(),"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND status='queued' RETURNING id`, [runId,userId])
    if (!updated.rowCount) return false
    await tx.query(`UPDATE github_ci_observations SET "deliveredFingerprint"=CASE WHEN "deliveredFingerprint"=$5 THEN NULL ELSE "deliveredFingerprint" END,"nextCheckAt"=now(),generation=generation+1,"updatedAt"=now() WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4`, [userId,expected.issueId,expected.remoteKey,expected.prNumber,expected.fingerprint])
    return true
  })
}

/** No assignment bytes were returned. Revoke its provisional token and make
 * the same run claimable again; preflight will re-read GitHub before retry. */
export async function retryUnsentCiClaim(userId: string, runId: string, expected: CiContinuation, leaseExpiresAt: string) {
  return ciTransaction(async tx => {
    await tx.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [expected.issueId])
    const { rows: [run] } = await tx.query('SELECT status,"stopRequestedAt","ciContinuation","leaseExpiresAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, userId])
    if (!run || run.status !== 'preparing' || run.stopRequestedAt || !same(run.ciContinuation, expected) || !(run.leaseExpiresAt instanceof Date) || run.leaseExpiresAt.toISOString() !== leaseExpiresAt) return false
    await tx.query('UPDATE run_tokens SET "revokedAt"=now() WHERE "runId"=$1 AND "userId"=$2 AND "revokedAt" IS NULL', [runId, userId])
    const issued = await tx.query('SELECT id FROM improvement_skill_receipts WHERE "runId"=$1 AND "userId"=$2', [runId,userId])
    if (issued.rowCount) {
      // This receipt is immutable and tied to the original lease. No assignment
      // bytes escaped; retire it and let the observation create a fresh run.
      await tx.query(`UPDATE agent_runs SET status='stopped',"stopReason"='superseded',error='CI assignment changed before delivery.',"finishedAt"=now(),"updatedAt"=now() WHERE id=$1`, [runId])
      await tx.query(`UPDATE github_ci_observations SET "deliveredFingerprint"=CASE WHEN "deliveredFingerprint"=$5 THEN NULL ELSE "deliveredFingerprint" END,"nextCheckAt"=now(),generation=generation+1,"updatedAt"=now() WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND "originRunId"=$6`, [userId,expected.issueId,expected.remoteKey,expected.prNumber,expected.fingerprint,expected.originRunId])
    } else await tx.query("UPDATE agent_runs SET status='queued',\"updatedAt\"=now() WHERE id=$1", [runId])
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
  return result.rowCount ?? 0
}

/** During bounded reconciliation, release queued CI follow-ups whose parent
 * mailbox grant was revoked even when their device is offline. The caller
 * holds the issue and observation locks and retains the transaction on return. */
export async function retireRevokedMailboxCiRuns(tx: PoolClient, userId: string, current: { issueId: string; remoteKey: string; prNumber: number; head: string; fingerprint: string }) {
  const { rows } = await tx.query(`SELECT r.id,r."botId",r."agentDefinition",origin."agentDefinition" AS "originDefinition"
    FROM agent_runs r JOIN agent_runs origin ON origin.id=(r."ciContinuation"->>'originRunId')::uuid AND origin."userId"=r."userId" AND origin."issueId"=r."issueId"
    WHERE r."userId"=$1 AND r."issueId"=$2 AND r.status='queued' AND r."stopRequestedAt" IS NULL
      AND r."ciContinuation"->>'remoteKey'=$3 AND r."ciContinuation"->>'prNumber'=$4
      AND r."ciContinuation"->>'head'=$5 AND r."ciContinuation"->>'fingerprint'=$6
      AND (r."agentDefinition" ? 'mailbox' OR origin."agentDefinition" ? 'mailbox')
    ORDER BY r.id LIMIT 20 FOR UPDATE OF r FOR SHARE OF origin`, [userId,current.issueId,current.remoteKey,String(current.prNumber),current.head,current.fingerprint])
  let retired = 0
  for (const row of rows) {
    if (await currentContinuationMailboxAuthorized(tx, userId, row.botId, row.originDefinition, row.agentDefinition, process.env.MIKKA_PERSONAL_MAILBOX_ENABLED === '1')) continue
    const result = await tx.query(`UPDATE agent_runs SET status='stopped',"stopReason"='blocked',error='CI follow-up mailbox authorization was revoked.',"finishedAt"=now(),"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND status='queued' AND "stopRequestedAt" IS NULL RETURNING id`, [row.id,userId])
    retired += result.rowCount ?? 0
  }
  return retired
}

/** Stop revoked skill-selected CI continuations even while their device is offline.
 * Caller owns the observation transaction; skill eligibility and selection are
 * rechecked under the existing skill-scope locks before changing a run. */
export async function retireRevokedCiSkillRuns(tx: PoolClient, userId: string, current: { issueId: string; remoteKey: string; prNumber: number; head: string; fingerprint: string }) {
  const { rows } = await tx.query(`SELECT r.id FROM agent_runs r JOIN improvement_skill_selections s ON s."runId"=r.id AND s."userId"=r."userId"
    WHERE r."userId"=$1 AND r."issueId"=$2 AND r.status='queued' AND r."stopRequestedAt" IS NULL
      AND r."ciContinuation"->>'remoteKey'=$3 AND r."ciContinuation"->>'prNumber'=$4
      AND r."ciContinuation"->>'head'=$5 AND r."ciContinuation"->>'fingerprint'=$6 ORDER BY r.id LIMIT 20`, [userId,current.issueId,current.remoteKey,String(current.prNumber),current.head,current.fingerprint])
  if (!rows.length) return 0
  const { skillAssignments } = await import('@/lib/self-improvement/server')
  let retired = 0
  for (const row of rows) {
    if (await skillAssignments.ciSelectionCurrent(tx, userId, row.id)) continue
    const result = await tx.query(`UPDATE agent_runs SET status='stopped',"stopReason"='blocked',error='CI follow-up skill authorization was revoked.',"finishedAt"=now(),"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND status='queued' AND "stopRequestedAt" IS NULL RETURNING id`, [row.id,userId])
    retired += result.rowCount ?? 0
  }
  return retired
}
