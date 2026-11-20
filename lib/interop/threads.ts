import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { readRunChain, readRunChainCheckpoint, type RunChain } from '@/lib/run-chain'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { secretMaskerFor } from '@/lib/secrets/runtime'
import { maskDeep } from '@/lib/secrets/mask'
import { InteropError, type InteropErrorDetail } from './errors'
import { admitPrincipal, principalSender, requireInterop, type InteropPrincipal } from './principal'

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

/** A stable request id for one logical send, so a retried tool call never starts two continuations. */
export function interopRequestId(principal: InteropPrincipal, rootRunId: string, key: string): string {
  const sender = principalSender(principal)
  const hex = createHash('sha256').update(`interop:${sender.kind}:${sender.id}:${rootRunId}:${key}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Send to a thread as its owner's peer. A working thread gets the text as a
 * queued message or a steer; an ended thread continues in the same thread on
 * its own machine, through the owner's ordinary admission and quota.
 */
export async function sendToThread(principal: InteropPrincipal, input: { runId: string; text: string; key: string; delivery?: 'queue' | 'steer' }): Promise<{ runId: string; continued: boolean }> {
  const parsed = z.object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000), key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    delivery: z.enum(['queue', 'steer']).optional() }).safeParse(input)
  if (!parsed.success) throw new InteropError('interop_invalid_request', { cause: parsed.error })
  const { ownerId, chain } = await authorizedThread(principal, parsed.data.runId, 'canSteer')
  const sender = principalSender(principal)
  const text = sender.kind === 'account' && sender.id === ownerId ? parsed.data.text : `[From ${sender.kind} ${sender.id}]\n${parsed.data.text}`
  const { sendThreadMessage } = await import('@/lib/thread-continue')
  const requestId = interopRequestId(principal, chain.rootRunId, parsed.data.key)
  // `queue`/`steer` describe a working thread. An ended thread (done, failed,
  // stopped) is woken by the plain send, which continues it in the same thread.
  const latest = chain.attempts.find(attempt => attempt.runId === chain.latestRunId)
  const active = UNFINISHED_RUN_STATUSES.some(status => status === latest?.status)
  try {
    return await sendThreadMessage(ownerId, chain.latestRunId, text, 'peer', requestId, active ? parsed.data.delivery ?? 'queue' : undefined)
  } catch (error) {
    if (error instanceof ActionFailureError) {
      const detail = SEND_FAILURES[error.code]
      if (detail) throw new InteropError('interop_send_unavailable', { detail, cause: error })
      if (error.code === 'runNotFound') throw new InteropError('interop_not_found', { cause: error })
      if (error.code === 'messageRequired' || error.code === 'validationGeneric') throw new InteropError('interop_invalid_request', { cause: error })
    }
    throw error
  }
}
