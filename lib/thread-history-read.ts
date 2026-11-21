import 'server-only'
import { pool } from '@/lib/db'
import { chainChunks } from './issue-run-conversation'
import { THREAD_HISTORY_PAGE_SIZE, type ThreadHistoryInput, type ThreadHistoryPosition } from './thread-history'

type Row = ThreadHistoryPosition & { createdAt: Date; chunk: Record<string, unknown> | null }

export async function readThreadHistory(runIds: string[], direction: 'latest' | 'before' | 'after', cursor?: ThreadHistoryPosition) {
  const order = direction === 'after' ? 'ASC' : 'DESC'
  const compare = direction === 'latest' ? '' : direction === 'before' ? '<' : '>'
  const boundary = compare ? `AND ("createdAt", lane, "runId", seq, id) ${compare} ($3::timestamptz,$4::integer,$5::uuid,$6::integer,$7::uuid)` : ''
  // Sort only event keys. Read the chunk JSON and message bodies for the chosen page.
  const { rows } = await pool.query<Row>(`
    WITH candidates AS (
      SELECT id, "runId", seq, "createdAt", 0 AS lane FROM run_chunks WHERE "runId" = ANY($1::uuid[])
      UNION ALL
      SELECT id, "runId", 0 AS seq, "createdAt", 1 AS lane FROM run_messages WHERE "runId" = ANY($1::uuid[])
    ), page AS (
      SELECT * FROM candidates WHERE true ${boundary}
      ORDER BY "createdAt" ${order}, lane ${order}, "runId" ${order}, seq ${order}, id ${order} LIMIT $2
    )
    SELECT page.*, to_char(page."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, c.chunk
    FROM page LEFT JOIN run_chunks c ON page.lane = 0 AND c.id = page.id
    ORDER BY page."createdAt" ${order}, page.lane ${order}, page."runId" ${order}, page.seq ${order}, page.id ${order}
  `, [runIds, THREAD_HISTORY_PAGE_SIZE + 1, ...cursor ? [cursor.at, cursor.lane, cursor.runId, cursor.seq, cursor.id] : []])
  const more = rows.length > THREAD_HISTORY_PAGE_SIZE
  const page = rows.slice(0, THREAD_HISTORY_PAGE_SIZE)
  if (direction !== 'after') page.reverse()
  const position = ({ at, lane, runId, seq, id }: Row): ThreadHistoryPosition => ({ at, lane, runId, seq, id })
  return {
    more,
    earliest: page[0] ? position(page[0]) : null,
    latest: page.length ? position(page[page.length - 1]) : null,
    chunks: chainChunks(page.flatMap(row => row.chunk ? [{ runId: row.runId, chunk: row.chunk, at: row.createdAt }] : []), runIds.length > 1),
    messageIds: page.filter(row => row.lane === 1).map(row => row.id),
  }
}

async function historyCount(runIds: string[]): Promise<number> {
  const { rows: [row] } = await pool.query<{ count: number }>(`
    SELECT ((SELECT count(*) FROM run_chunks WHERE "runId" = ANY($1::uuid[]))
      + (SELECT count(*) FROM run_messages WHERE "runId" = ANY($1::uuid[])))::int AS count
  `, [runIds])
  return row.count
}

export async function readLatestThreadHistory(runIds: string[], after: ThreadHistoryInput['after']) {
  const chain = runIds.join(',')
  if (after?.chain === chain && runIds.includes(after.position.runId)) {
    const [next, count] = await Promise.all([readThreadHistory(runIds, 'after', after.position), historyCount(runIds)])
    // An event inserted before the cursor or a replaced batch invalidates the held window.
    if (!next.more && count === after.count + next.chunks.length + next.messageIds.length) {
      return { ...next, historyPage: { chain, count, before: null, latest: next.latest ?? after.position, append: true } }
    }
  }
  // Count before reading the tail. A racing insert can force a conservative refresh on the next read.
  const count = await historyCount(runIds)
  const newest = await readThreadHistory(runIds, 'latest')
  return { ...newest, historyPage: { chain, count, before: newest.more ? newest.earliest : null, latest: newest.latest, append: false } }
}
