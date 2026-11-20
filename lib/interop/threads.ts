import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { readRunChain, readRunChainCheckpoint, type RunChain } from '@/lib/run-chain'
import { secretMaskerFor } from '@/lib/secrets/runtime'
import { maskDeep } from '@/lib/secrets/mask'
import { InteropError, type InteropErrorDetail } from './errors'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { ContinuationGrantRequired, hasExplicitContinuationGrant, type ContinuationSubject } from './continuation-grant'
import { admitPrincipal, principalOwner, principalSender, principalSubject, requireInterop, type InteropPrincipal } from './principal'

/** The sender's own subject and, for a run or Bot, the member account behind it. */
function continuationSubjects(principal: InteropPrincipal): ContinuationSubject[] {
  const owner = principalOwner(principal), subject = principalSubject(principal)
  return [...(owner ? [{ kind: 'account' as const, id: owner }] : []), ...(subject ? [subject] : [])]
}

/** Enough of a transcript to act on; the full stream stays a human surface. */
const AGENT_TEXT_TAIL = 8_000
const MESSAGE_LIMIT = 50
const DIFF_LIMIT = 512 * 1024
const uuid = z.uuid()

export type ThreadTarget = { ownerId: string; workspaceId: string; chain: RunChain }

/**
 * The thread `runId` belongs to, after the principal passes the ACL on its root
 * run. A thread of another tenant, a missing one and a forbidden one are all
 * `interop_not_found`.
 */
export async function authorizedThread(principal: InteropPrincipal, runId: string, action: 'canReadContent' | 'canSteer'): Promise<ThreadTarget> {
  if (!uuid.safeParse(runId).success) throw new InteropError('interop_not_found')
  await admitPrincipal(principal)
  const { rows: [run] } = await pool.query<{ userId: string; workspaceId: string | null }>(
    'SELECT "userId","workspaceId" FROM agent_runs WHERE id=$1', [runId])
  if (!run || run.workspaceId !== principal.workspaceId) throw new InteropError('interop_not_found')
  const chain = await readRunChain(pool, run.userId, runId)
  if (!chain) throw new InteropError('interop_not_found')
  await requireInterop(principal, { kind: 'thread', id: chain.rootRunId }, action)
  return { ownerId: run.userId, workspaceId: run.workspaceId, chain }
}

export interface ThreadSummary { runId: string; rootRunId: string; issueId: string | null; status: string; title: string | null; ownedByOwner: boolean; updatedAt: string }

/** Threads in the principal's tenant it may read: newest first, one row per thread (its latest run). */
export async function listThreads(principal: InteropPrincipal, input: { issueId?: string; limit?: number } = {}): Promise<ThreadSummary[]> {
  await admitPrincipal(principal)
  if (input.issueId !== undefined && !uuid.safeParse(input.issueId).success) throw new InteropError('interop_invalid_request')
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50))
  const owner = principal.kind === 'service' ? null : principal.kind === 'account' ? principal.userId : principal.ownerId
  const subject = principal.kind === 'account' ? null : { kind: principal.kind, id: principal.kind === 'bot' ? principal.botId : principal.kind === 'run' ? principal.runId : principal.serviceId }
  // A root run is one that continues nothing; its thread ACL decides the whole chain.
  const { rows } = await pool.query<{ rootRunId: string; runId: string; issueId: string | null; status: string; title: string | null; ownerId: string; updatedAt: Date }>(
    `SELECT root.id AS "rootRunId", latest.id AS "runId", root."issueId", latest.status, i.title, root."userId" AS "ownerId", latest."createdAt" AS "updatedAt"
     FROM agent_runs root
     LEFT JOIN issues i ON i.id=root."issueId"
     CROSS JOIN LATERAL (
       WITH RECURSIVE chain AS (
         SELECT r.id,r."createdAt",r.status,0 AS depth FROM agent_runs r WHERE r.id=root.id
         UNION ALL SELECT c.id,c."createdAt",c.status,chain.depth+1 FROM chain JOIN agent_runs c
           ON chain.id IN (c."continuesRunId",c."retryOf") AND c."userId"=root."userId" AND c."workspaceId"=root."workspaceId"
           AND c."issueId" IS NOT DISTINCT FROM root."issueId" WHERE chain.depth<64
       ) SELECT id,status,"createdAt" FROM chain ORDER BY "createdAt" DESC, id DESC LIMIT 1
     ) latest
     WHERE root."workspaceId"=$1 AND root."continuesRunId" IS NULL AND root."retryOf" IS NULL AND root.kind<>'group_review'
       AND ($2::uuid IS NULL OR root."issueId"=$2)
       AND (($3::text IS NOT NULL AND mikka_resource_acl_allowed('account',$3,$1,'thread',root.id,'canReadContent'))
         OR ($4::text IS NOT NULL AND mikka_resource_acl_allowed($5,$4,$1,'thread',root.id,'canReadContent')))
     ORDER BY latest."createdAt" DESC, root.id DESC LIMIT $6`,
    [principal.workspaceId, input.issueId ?? null, owner, subject?.id ?? null, subject?.kind ?? 'account', limit])
  return rows.map(row => ({ runId: row.runId, rootRunId: row.rootRunId, issueId: row.issueId, status: row.status, title: row.title,
    ownedByOwner: row.ownerId === owner, updatedAt: row.updatedAt.toISOString() }))
}

export interface ThreadAttemptView { runId: string; attempt: number; status: string; summary: string | null; agentText: string; messages: { text: string; createdAt: string }[] }

/** Text an agent streamed, assembled from its AI SDK text deltas. */
export function agentTextFromChunks(chunks: readonly Record<string, unknown>[], limit = AGENT_TEXT_TAIL): string {
  let text = ''
  for (const chunk of chunks) if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') text += chunk.delta
  return text.length > limit ? text.slice(-limit) : text
}

/** The thread's attempts with what was sent to it and what its agent said, masked with the owner's Secrets. */
export async function readThreadMessages(principal: InteropPrincipal, runId: string): Promise<{ rootRunId: string; latestRunId: string; attempts: ThreadAttemptView[] }> {
  const { ownerId, workspaceId, chain } = await authorizedThread(principal, runId, 'canReadContent')
  const runIds = chain.attempts.map(attempt => attempt.runId)
  const [{ rows: reports }, { rows: messages }, { rows: chunks }] = await Promise.all([
    pool.query<{ id: string; summary: string | null }>(`SELECT id, report->>'summary' AS summary FROM agent_runs WHERE id=ANY($1::uuid[])`, [runIds]),
    pool.query<{ runId: string; text: string; createdAt: Date }>(`SELECT "runId",text,"createdAt" FROM run_messages
      WHERE "runId"=ANY($1::uuid[]) ORDER BY "createdAt" DESC LIMIT $2`, [runIds, MESSAGE_LIMIT]),
    // The newest chunks of each attempt, bounded per run.
    pool.query<{ runId: string; chunk: Record<string, unknown> }>(`SELECT c."runId",c.chunk FROM unnest($1::uuid[]) AS r(id)
      CROSS JOIN LATERAL (SELECT "runId",chunk,seq FROM run_chunks WHERE "runId"=r.id ORDER BY seq DESC LIMIT 400) c
      ORDER BY c."runId", c.seq`, [runIds]),
  ])
  const summaries = new Map(reports.map(row => [row.id, row.summary]))
  const attempts = chain.attempts.map(attempt => ({
    runId: attempt.runId, attempt: attempt.attempt, status: attempt.status, summary: summaries.get(attempt.runId) ?? null,
    agentText: agentTextFromChunks(chunks.filter(row => row.runId === attempt.runId).map(row => row.chunk)),
    messages: messages.filter(row => row.runId === attempt.runId).reverse().map(row => ({ text: row.text, createdAt: row.createdAt.toISOString() })),
  }))
  const mask = await secretMaskerFor({ workspaceId, ownerId })
  return maskDeep({ rootRunId: chain.rootRunId, latestRunId: chain.latestRunId, attempts }, mask)
}

/**
 * The thread's retained checkpoint patch: the changes its runs left in the
 * working tree. Refused, not partially shown, when the owner's Secret masker
 * would change any byte (the same rule as the live diff route).
 */
export async function readRunDiff(principal: InteropPrincipal, runId: string): Promise<{ rootRunId: string; patch: string; truncated: boolean }> {
  const { ownerId, workspaceId, chain } = await authorizedThread(principal, runId, 'canReadContent')
  const { checkpoint } = await readRunChainCheckpoint(pool, ownerId, chain.latestRunId)
  if (!checkpoint || checkpoint.unavailableReason) throw new InteropError('interop_diff_unavailable', { detail: 'no_checkpoint' })
  const full = checkpoint.patch.toString('utf8')
  const patch = full.slice(0, DIFF_LIMIT)
  const mask = await secretMaskerFor({ workspaceId, ownerId })
  if (mask(patch) !== patch) throw new InteropError('interop_diff_unavailable', { detail: 'masked' })
  return { rootRunId: chain.rootRunId, patch, truncated: full.length > patch.length }
}

const SEND_FAILURES: Record<string, InteropErrorDetail> = {
  runNotActive: 'run_not_active', threadReplaced: 'thread_replaced', threadCannotContinue: 'thread_cannot_continue',
  threadDeliveryUnavailable: 'delivery_unavailable',
}

/** One logical send's fingerprint: a key reused for different words is refused. */
function sendDigest(text: string, delivery: 'queue' | 'steer' | undefined): string {
  return createHash('sha256').update(JSON.stringify([text, delivery ?? 'queue'])).digest('hex')
}

const sendResult = z.object({ runId: z.uuid(), continued: z.boolean() }).strict()

/**
 * Send to a thread as its owner's peer. A working thread gets the text as a
 * peer message or a native steer; an ended thread continues in the same thread
 * on its own machine, through the owner's ordinary admission and quota. The
 * key makes it idempotent per sender and thread: a retry returns the first
 * result and never starts a second continuation.
 */
export async function sendToThread(principal: InteropPrincipal, input: { runId: string; text: string; key: string; delivery?: 'queue' | 'steer' }): Promise<{ runId: string; continued: boolean }> {
  const parsed = z.object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000), key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    delivery: z.enum(['queue', 'steer']).optional() }).safeParse(input)
  if (!parsed.success) throw new InteropError('interop_invalid_request', { cause: parsed.error })
  const { ownerId, chain } = await authorizedThread(principal, parsed.data.runId, 'canSteer')
  const sender = principalSender(principal)
  const text = sender.kind === 'account' && sender.id === ownerId ? parsed.data.text : `[From ${sender.kind} ${sender.id}]\n${parsed.data.text}`
  // Waking an ended thread spends its owner's subscription, quota and machine: a peer needs the owner's explicit grant.
  const latest = chain.attempts.find(attempt => attempt.runId === chain.latestRunId)
  const ended = !UNFINISHED_RUN_STATUSES.some(status => status === latest?.status)
  if (ended && principalOwner(principal) !== ownerId && !await hasExplicitContinuationGrant(pool, chain.rootRunId, continuationSubjects(principal)))
    throw new InteropError('interop_send_unavailable', { detail: 'continuation_requires_grant', cause: new ContinuationGrantRequired() })
  const digest = sendDigest(parsed.data.text, parsed.data.delivery)
  const receipt = [chain.rootRunId, sender.kind, sender.id, parsed.data.key]
  const { rowCount } = await pool.query(`INSERT INTO interop_thread_sends ("rootRunId","senderKind","senderId",key,"requestDigest")
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...receipt, digest])
  if (!rowCount) {
    const { rows: [prior] } = await pool.query<{ requestDigest: string; result: unknown }>(`SELECT "requestDigest",result FROM interop_thread_sends
      WHERE "rootRunId"=$1 AND "senderKind"=$2 AND "senderId"=$3 AND key=$4`, receipt)
    if (prior && prior.requestDigest !== digest) throw new InteropError('interop_invalid_request')
    const replay = sendResult.safeParse(prior?.result)
    if (replay.success) return replay.data
    // An intent without an outcome is never delivered a second time.
    throw new InteropError('interop_send_unavailable', { detail: 'delivery_uncertain' })
  }
  const { sendPeerThreadMessage } = await import('@/lib/thread-continue')
  let result: { runId: string; continued: boolean }
  try {
    result = await sendPeerThreadMessage(ownerId, chain.latestRunId, text, parsed.data.delivery === 'steer' ? 'steer' : undefined)
  } catch (error) {
    if (error instanceof ActionFailureError) {
      // A refusal delivered nothing: release the key so a later retry may try again.
      await pool.query(`DELETE FROM interop_thread_sends WHERE "rootRunId"=$1 AND "senderKind"=$2 AND "senderId"=$3 AND key=$4 AND result IS NULL`, receipt)
      const detail = SEND_FAILURES[error.code]
      if (detail) throw new InteropError('interop_send_unavailable', { detail, cause: error })
      if (error.code === 'runNotFound') throw new InteropError('interop_not_found', { cause: error })
      if (error.code === 'messageRequired' || error.code === 'validationGeneric') throw new InteropError('interop_invalid_request', { cause: error })
    }
    throw error
  }
  await pool.query(`UPDATE interop_thread_sends SET result=$5 WHERE "rootRunId"=$1 AND "senderKind"=$2 AND "senderId"=$3 AND key=$4`, [...receipt, JSON.stringify(result)])
  return result
}
