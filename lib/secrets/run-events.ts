import 'server-only'
// Stores one batch of a run's UI message chunks (POST /v1/runs/:runId/events). Split out of the
// route so the DB tests drive the real write path. #438 A: streamed parts are masked across the
// chunks of a batch (stream-mask.ts, hold-back in memory only); lastReply is masked again on its full text.
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, runChunks } from '@/lib/db/schema'
import { freshChunks, nextReply } from '@/lib/thread-groups'
import { identityMasker, type Masker } from './mask'
import { maskStreamedChunks } from './stream-mask'
import { runChanged, threadChanged } from '../live/panels'
import { runListChanged } from '../live/lists'
import { taskActivityChanged } from '../factory/activity-live'

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

export async function persistRunEventBatch(runId: string, fromSeq: number, input: Record<string, unknown>[], mask: Masker) {
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
    await recordLastReply(tx, runId, fresh, mask)
    const started = await tx.update(agentRuns).set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'preparing'))).returning({ id: agentRuns.id })
    if (started.length) {
      await runListChanged(tx, runId)
      await runChanged(tx, runId)
      taskActivityChanged(tx, runId)
    }
    if (inserted.length) await threadChanged(tx, runId)
    // The list displays completed reply previews. Individual text tokens stay
    // on the thread's stream and do not re-read every task on the board.
    if (fresh.some(chunk => chunk.type === 'text-end' || chunk.type === 'finish')) await runListChanged(tx, runId, true)
  })
}
