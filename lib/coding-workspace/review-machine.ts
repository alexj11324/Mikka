import 'server-only'
import { Sandbox } from 'e2b'
import type { Pool } from 'pg'
import { TerminalError } from '@mikka/protocol/coding-terminal'
import { e2bApiKey, withE2BErrors } from '@/lib/secrets/e2b-runtime'
import { cloudflareReview, reviewReply } from './cloudflare-review'
import type { ReviewSessionLease } from './review-sessions'
import type { TaskReviewAuthority } from './review-authority'

type Lease = ReviewSessionLease
type Dependencies = { database: Pick<Pool, 'connect' | 'query'>; resume: (scope: TaskReviewAuthority & { sandboxId: string }, milliseconds: number, signal?: AbortSignal) => Promise<void> }
const TERMINAL = new Set(['succeeded', 'failed'])

/** A review lease resumes the same parked VM's memory, never an Agent claim,
 * device credential, worker bootstrap, repository checkout or new sandbox. */
export async function resumeReviewMachine(scope: TaskReviewAuthority, lease: Lease, signal?: AbortSignal,
  dependencies?: Dependencies): Promise<void> {
  if (scope.machineKind !== 'cloud') return
  const sponsored = scope.sponsoredPlacement && cloudflareReview(scope,lease,lease.reviewKind ?? 'terminal')
  const attach = async () => {
    if (sponsored && (await reviewReply(sponsored,'attach',{},signal)).attached !== true)
      throw new TerminalError('terminal_binding_changed')
  }
  if (scope.machineStatus === 'running') { await attach(); return }
  if (!scope.sandboxId || scope.machineStatus !== 'paused' || !scope.nativeExitedProof || !TERMINAL.has(scope.runStatus))
    throw new TerminalError('terminal_already_controlled')
  signal?.throwIfAborted()
  const database = dependencies?.database ?? (await import('@/lib/db')).pool
  const resume = dependencies?.resume ?? (async (target, milliseconds, abort) => {
    const apiKey = await e2bApiKey(target.ownerId, 'Task review is not configured')
    await withE2BErrors(target.ownerId, false, () => Sandbox.connect(target.sandboxId, {
      apiKey, timeoutMs: milliseconds, requestTimeoutMs: 20_000, signal: abort, retries: 0,
      proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    }))
  })
  const values = [scope.runId, scope.ownerId, scope.workspaceId, scope.deviceId, scope.sandboxId,
    scope.machineEpoch, scope.machineOperationId, lease.id, scope.bindingId]
  const eligible = `m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."deviceId"=$4
    AND m."sandboxId"=$5 AND m.epoch=$6 AND m."operationId"=$7
    AND r.id=m."runId" AND r."userId"=$2 AND r."stopRequestedAt" IS NULL
    AND r.status IN ('succeeded','failed')
    AND r.report->'safePoint'->>'session'='exited'
    AND i.id=m."issueId" AND i.status NOT IN ('done','canceled','duplicate')
    AND i.content->'attrs'->'mikka'->>'deletedAt' IS NULL
    AND d.id=m."deviceId" AND d."ownerId"=$2 AND d.enabled=true AND d."removedAt" IS NULL
    AND EXISTS (SELECT 1 FROM coding_review_sessions s WHERE s.id=$8 AND s."runId"=$1
      AND s."ownerId"=$2 AND s."workspaceId"=$3 AND s."deviceId"=$4 AND s."sandboxId"=$5
      AND s."machineEpoch"=$6 AND s."machineOperationId"=$7 AND s."bindingId"=$9
      AND s."revokedAt" IS NULL AND s."expiresAt">clock_timestamp())`
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='15s'")
    // Same APP lock order as lifecycle/deletion. Do not hold any lock across
    // E2B I/O; the durable lease/intent fences its completion afterwards.
    await client.query('SELECT id FROM issues WHERE id=$1 FOR SHARE', [scope.taskId])
    await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR SHARE', [scope.runId, scope.ownerId])
    await client.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [scope.runId])
    const claimed = await client.query(`UPDATE thread_machines m SET lifecycle=m.lifecycle||jsonb_build_object(
        'phase','review_resume_requested','reviewSessionId',$8::text),"lifecycleAt"=clock_timestamp()
      FROM agent_runs r,issues i,devices d WHERE ${eligible} AND m.state='paused'
      AND (m."workerLeaseUntil" IS NULL OR m."workerLeaseUntil"<=clock_timestamp()) RETURNING m."runId"`, values)
    if (!claimed.rowCount) throw new TerminalError('terminal_binding_changed')
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }

  try {
    signal?.throwIfAborted()
    const remaining = Math.min(300_000, Date.parse(lease.expiresAt) - Date.now())
    if (remaining <= 0) throw new TerminalError('terminal_unavailable', { detail: 'lease' })
    if (sponsored) await attach()
    else await resume({ ...scope, sandboxId: scope.sandboxId }, remaining, signal)
    signal?.throwIfAborted()
    const applied = await database.query(`UPDATE thread_machines m SET state='running',"runningSince"=clock_timestamp(),
      "lastActiveAt"=clock_timestamp(),"lifecycleAt"=(SELECT "expiresAt" FROM coding_review_sessions WHERE id=$8),
      lifecycle=(m.lifecycle-'pausedAt')||jsonb_build_object('phase','review_resumed','reviewSessionId',$8::text)
      FROM agent_runs r,issues i,devices d WHERE ${eligible} AND m.state='paused'
        AND m.lifecycle->>'phase'='review_resume_requested' AND m.lifecycle->>'reviewSessionId'=$8::text
      RETURNING m."runId"`, values)
    if (!applied.rowCount) throw new TerminalError('terminal_binding_changed')
  } catch (cause) {
    // An SDK error is not proof the VM remained paused. Make the existing
    // lifecycle reconcile provider truth promptly after the caller closes its
    // review lease; never delete files, mint credentials or retry execution.
    await database.query(`UPDATE thread_machines SET "lifecycleAt"=clock_timestamp(),
      lifecycle=lifecycle||jsonb_build_object('phase','review_resume_failed')
      WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "deviceId"=$4 AND "sandboxId"=$5
        AND epoch=$6 AND "operationId"=$7 AND lifecycle->>'reviewSessionId'=$8::text`, values.slice(0, 8)).catch(() => undefined)
    if (cause instanceof TerminalError) throw cause
    throw new TerminalError('terminal_unavailable', { detail: 'runtime', cause })
  }
}
