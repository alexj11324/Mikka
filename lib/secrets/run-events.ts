import 'server-only'
// Stores one batch of a run's UI message chunks (POST /v1/runs/:runId/events). Split out of the
// route so the DB tests drive the real write path. #438 A: streamed parts are masked across the
// chunks of a batch (stream-mask.ts, hold-back in memory only); lastReply is masked again on its full text.
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns, runChunks } from '@/lib/db/schema'
import { freshChunks, nextReply } from '@/lib/thread-groups'
import { identityMasker, type Masker } from './mask'
import { maskStreamedChunks } from './stream-mask'
import { runChanged, threadChanged } from '../live/panels'
import { runListChanged } from '../live/lists'
import { taskActivityChanged } from '../factory/activity-live'
import { readRunChain } from '../run-chain'
import { recordExternalModelUsage } from '../model-gateway/ledger'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Keeps `agent_runs.lastReply` on the opening of the agent's latest text part
 * (lib/thread-groups.ts `nextReply`), in the same transaction as the insert.
 * The row is locked so two batches of one run cannot interleave.
 */
async function recordLastReply(tx: Tx, runId: string, chunks: Record<string, unknown>[], mask: Masker) {
  if (!chunks.some(chunk => chunk.type === 'text-delta')) return
  const [stored] = await tx.select({ lastReply: agentRuns.lastReply, lastReplyPart: agentRuns.lastReplyPart }).from(agentRuns)
    .where(eq(agentRuns.id, runId)).for('no key update')
  if (!stored) return
  const next = nextReply(stored, chunks)
  if (!next) return
  // #438 A: nextReply rebuilds the text from stored reply + new deltas; mask the full text again.
  if (next.lastReply) next.lastReply = mask(next.lastReply)
  await tx.update(agentRuns).set({ ...next, lastReplyAt: new Date() }).where(eq(agentRuns.id, runId))
}

// Older daemons can report agent output before the explicit running PATCH.
// Framing also wraps repository preparation, so it cannot establish execution.
function reportsExecution(chunk: Record<string, unknown>): boolean {
  if (chunk.type === 'data-run-state') {
    const state = chunk.data
    return typeof state === 'object' && state !== null && 'state' in state && state.state === 'running'
  }
  return chunk.type !== 'data-run-stage' && chunk.type !== 'start' && chunk.type !== 'finish'
}

async function subscriptionRun(runId: string) {
  const { rows: [run] } = await pool.query<{ workspaceId: string; ownerId: string; route: string }>(`
    SELECT r."workspaceId",r."userId" AS "ownerId",b.route
    FROM byos_native_runs n JOIN agent_runs r ON r.id=n."runId"
    JOIN byos_bindings b ON b.id=n."bindingId"
    WHERE r.id=$1 AND r."workspaceId" IS NOT NULL`, [runId])
  if (!run) return null
  const threadId = (await readRunChain(pool, run.ownerId, runId))?.rootRunId ?? null
  return { ...run, threadId }
}

function subscriptionUsage(chunk: Record<string, unknown>, route: string) {
  if (chunk.type !== 'data-usage' || !chunk.data || typeof chunk.data !== 'object') return null
  const data = chunk.data as Record<string, unknown>
  // Older Codex daemons report a thread total, not a turn total.
  const codex = route.startsWith('codex')
  const usage = codex ? data.turnUsage as typeof data | undefined : data
  const input = usage?.inputTokens, output = usage?.outputTokens
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 ||
      typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) return null
  const cacheTokens = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  const cacheReadTokens = codex ? null : cacheTokens(data.cacheReadTokens)
  const cacheWriteTokens = codex ? null : cacheTokens(data.cacheWriteTokens)
  const inputTokens = input + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (!Number.isSafeInteger(inputTokens)) return null
  const observed = typeof data.model === 'string' ? data.model.trim() : ''
  const model = observed && observed.length <= 500 ? observed : 'unknown'
  return { model, usage: { inputTokens, outputTokens: output, cacheReadTokens, cacheWriteTokens } }
}

export async function persistRunEventBatch(runId: string, fromSeq: number, input: Record<string, unknown>[], mask: Masker) {
  const subscription = input.some(chunk => chunk.type === 'data-usage') ? await subscriptionRun(runId) : null
  await db.transaction(async tx => {
    // A tool may read binary data (for example .git/index). JSON accepts NUL
    // and lone surrogates, but PostgreSQL JSONB rejects them, blocking the
    // daemon's ordered outbox including its completion. Keep the batch and its
    // sequence numbers, replacing only characters PostgreSQL cannot store.
    let chunks: Record<string, unknown>[] = JSON.parse(JSON.stringify(input, (_key, value) =>
      typeof value === 'string' ? value.replaceAll('\u0000', '\uFFFD').toWellFormed() : value))
    if (mask !== identityMasker) chunks = maskStreamedChunks(chunks, mask)
    const inserted = await tx.insert(runChunks)
      .values(chunks.map((chunk, index) => ({
        id: crypto.randomUUID(), runId, seq: fromSeq + index,
        chunk,
      })))
      .onConflictDoNothing()
      .returning({ seq: runChunks.seq })
    // Only chunks stored now count, so a re-sent batch never appends its text twice.
    const fresh = freshChunks(chunks, fromSeq, inserted.map(row => row.seq))
    if (subscription) {
      for (const { seq } of inserted) {
        const receipt = subscriptionUsage(chunks[seq - fromSeq], subscription.route)
        if (!receipt) continue
        const { rows: [start] } = await tx.execute<{ messageId: string | null }>(sql`
          SELECT chunk->>'messageId' AS "messageId" FROM run_chunks
          WHERE "runId"=${runId} AND seq<${seq} AND chunk->>'type'='start'
          ORDER BY seq DESC LIMIT 1`)
        const messageId = start?.messageId && /^[\w.-]{1,200}$/.test(start.messageId) ? start.messageId : null
        await recordExternalModelUsage(tx, { ...subscription, ...receipt, id: `subscription:${runId}:${seq}`, runId,
          messageId, source: 'subscription', cost: null })
      }
    }
    await recordLastReply(tx, runId, fresh, mask)
    if (fresh.some(reportsExecution)) {
      const started = await tx.update(agentRuns).set({ status: 'running', updatedAt: new Date() })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'preparing'))).returning({ id: agentRuns.id })
      if (started.length) {
        await runListChanged(tx, runId)
        await runChanged(tx, runId)
        taskActivityChanged(tx, runId)
      }
    }
    if (inserted.length) await threadChanged(tx, runId)
    // The list displays completed reply previews. Individual text tokens stay
    // on the thread's stream and do not re-read every task on the board.
    if (fresh.some(chunk => chunk.type === 'text-end' || chunk.type === 'finish')) await runListChanged(tx, runId, true)
  })
}
