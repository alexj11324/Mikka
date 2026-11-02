import 'server-only'
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, runChunks } from '@/lib/db/schema'
import { chainChunks } from '@/lib/issue-run-conversation'

/**
 * Where a client's copy of a thread's chunks ends. `chain` is the runs the
 * thread was read across; `runs` how many of them had chunks (chainChunks
 * renames ids once a second run has any, so that must not change underneath);
 * `count` how many chunks precede the cursor.
 */
export const threadChunkCursor = z.object({
  chain: z.string().max(4000),
  runId: z.uuid().nullable(),
  seq: z.number().int().min(0),
  runs: z.number().int().min(0),
  /** How many chunks the client holds: a batch stored late, below the cursor, makes the counts differ. */
  count: z.number().int().min(0),
})
export type ThreadChunkCursor = z.infer<typeof threadChunkCursor>

type Row = { runId: string; seq: number; chunk: Record<string, unknown>; at: Date }

/**
 * The thread's chunks, oldest run first. With the caller's cursor for the same
 * runs, only the chunks after it (`append: true`); a stored chunk never changes,
 * so the caller's copy plus these equals a full read. Otherwise the full read.
 */
export async function readThreadChunks(runIds: string[], after: ThreadChunkCursor | null) {
  const chain = runIds.join(',')
  const select = { runId: runChunks.runId, seq: runChunks.seq, chunk: runChunks.chunk, at: runChunks.createdAt }
  if (after && after.chain === chain && (after.runId === null || runIds.includes(after.runId))) {
    const later = after.runId === null
      ? inArray(runChunks.runId, runIds)
      : and(inArray(runChunks.runId, runIds), or(
        and(eq(runChunks.runId, after.runId), gt(runChunks.seq, after.seq)),
        sql`${agentRuns.createdAt} > (select ${agentRuns.createdAt} from ${agentRuns} where ${agentRuns.id} = ${after.runId})`,
      ))
    const [rows, [held]] = await Promise.all([
      db.select(select).from(runChunks).innerJoin(agentRuns, eq(agentRuns.id, runChunks.runId))
        .where(later).orderBy(asc(agentRuns.createdAt), asc(runChunks.seq)) as Promise<Row[]>,
      db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(runChunks).innerJoin(agentRuns, eq(agentRuns.id, runChunks.runId))
        .where(and(inArray(runChunks.runId, runIds), sql`not (${later})`)),
    ])
    const runs = after.runs + new Set(rows.map(row => row.runId).filter(id => id !== after.runId)).size
    // A second run's first chunks rename every id, and a batch stored below the cursor would be missed: read everything then.
    if ((after.runs > 1) === (runs > 1) && held?.count === after.count) return { chunks: chainChunks(rows, runs > 1), cursor: cursorAfter(chain, rows, after, runs), append: true }
  }
  const rows: Row[] = await db.select(select).from(runChunks).innerJoin(agentRuns, eq(agentRuns.id, runChunks.runId))
    .where(inArray(runChunks.runId, runIds)).orderBy(asc(agentRuns.createdAt), asc(runChunks.seq))
  const runs = new Set(rows.map(row => row.runId)).size
  return { chunks: chainChunks(rows, runs > 1), cursor: cursorAfter(chain, rows, null, runs), append: false }
}

function cursorAfter(chain: string, rows: Row[], after: ThreadChunkCursor | null, runs: number): ThreadChunkCursor {
  const last = rows.at(-1)
  const count = (after?.count ?? 0) + rows.length
  return last ? { chain, runId: last.runId, seq: last.seq, runs, count } : { chain, runId: after?.runId ?? null, seq: after?.seq ?? 0, runs, count }
}
