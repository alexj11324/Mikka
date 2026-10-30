import 'server-only'
// Stores one batch of a run's UI message chunks (POST /v1/runs/:runId/events). Split out of the
// route so the DB tests drive the real write path. #438 A: streamed parts are masked across chunk
// and batch boundaries (stream-mask.ts); lastReply is masked again on its full text.
import { and, eq, gte, lt } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, runChunks } from '@/lib/db/schema'
import { runMaskBuffers } from '@/lib/db/secrets-schema'
import { freshChunks, nextReply } from '@/lib/thread-groups'
import { openSecret, sealSecret } from './crypto'
import { identityMasker, maskDeep, type Masker } from './mask'
import { maskStreamedChunks } from './stream-mask'

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

const bufferAad = (runId: string, partKey: string) => ['run_mask_buffer', runId, partKey].join('\u0000')

/**
 * #438 A: masks a batch across chunk (and batch) boundaries. Chunks already stored (a re-sent
 * seq) never touch the buffers. Held-back raw text is stored sealed, never in plaintext.
 */
async function maskStream(tx: Tx, runId: string, chunks: Record<string, unknown>[], existing: Set<number>, fromSeq: number, mask: Masker) {
  const rows = await tx.select().from(runMaskBuffers).where(eq(runMaskBuffers.runId, runId))
  const pending = new Map(rows.map(row => [row.partKey, openSecret(row, bufferAad(runId, row.partKey))]))
  const before = new Map(pending)
  const out = chunks.map((chunk, index) => existing.has(fromSeq + index) ? maskDeep(chunk, mask) : null)
  const fresh = maskStreamedChunks(chunks.filter((_, index) => out[index] === null), mask, pending)
  let next = 0
  const result = out.map(chunk => chunk ?? fresh[next++]!)
  for (const key of before.keys()) if (!pending.has(key)) await tx.delete(runMaskBuffers).where(and(eq(runMaskBuffers.runId, runId), eq(runMaskBuffers.partKey, key)))
  for (const [partKey, held] of pending) {
    if (before.get(partKey) === held) continue
    const sealed = sealSecret(held, bufferAad(runId, partKey))
    await tx.insert(runMaskBuffers).values({ runId, partKey, ...sealed, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [runMaskBuffers.runId, runMaskBuffers.partKey], set: { ...sealed, updatedAt: new Date() } })
  }
  return result
}

export async function persistRunEventBatch(runId: string, fromSeq: number, input: Record<string, unknown>[], mask: Masker) {
  await db.transaction(async tx => {
    let chunks: Record<string, unknown>[] = input
    if (mask !== identityMasker) {
      // One batch of a run at a time: the hold-back buffers below are read and written under this lock.
      await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, runId)).for('no key update')
      const existing = new Set((await tx.select({ seq: runChunks.seq }).from(runChunks)
        .where(and(eq(runChunks.runId, runId), gte(runChunks.seq, fromSeq), lt(runChunks.seq, fromSeq + chunks.length)))).map(row => row.seq))
      chunks = await maskStream(tx, runId, chunks, existing, fromSeq, mask)
    }
    const inserted = await tx.insert(runChunks)
      .values(chunks.map((chunk, index) => ({
        id: crypto.randomUUID(), runId, seq: fromSeq + index,
        chunk,
      })))
      .onConflictDoNothing()
      .returning({ seq: runChunks.seq })
    // Only chunks stored now count, so a re-sent batch never appends its text twice.
    await recordLastReply(tx, runId, freshChunks(chunks, fromSeq, inserted.map(row => row.seq)), mask)
  })
}
