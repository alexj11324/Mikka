import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { maskForRun } from '@/lib/secrets/runtime'
import { readDecisionSource, sanitizeSourceText } from './sources'
import { resolveMapSource } from './source-scope'
import { withDatabaseClient } from '@/lib/db/request-scope'
import type { ProjectScope } from './scope'
import type { DecisionSourceLocator } from './contracts'
import { fingerprint, readMapToken, signMapToken, snapshotClaims, type MapClaims } from './cursor'
import { mapQuerySchema, MapReadError, MAP_SOURCE_BYTES } from './read-contracts'
import type { ListLiveRead } from '@/lib/live/list-read'
import { mapReadReply } from './read-response'

const sourceQuery = z.object({ workspaceId: z.uuid(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(8192).optional() }).strict()
/** Read a source only after the fresh project graph has proved its current owner/workspace/source ACL. */
export async function mapSourceHttp(request: Request, scope: ProjectScope, sourceRef: string, raw: Record<string, string>, live: ListLiveRead) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const response = await withDatabaseClient(client, () => sourceResponse(request, scope, sourceRef, raw, live))
    await client.query('COMMIT')
    return response
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => {})
    throw cause
  } finally { client.release() }
}
async function sourceResponse(_request: Request, scope: ProjectScope, sourceRef: string, raw: Record<string, string>, live: ListLiveRead) {
  const reply = (body: object) => {
    const content = { ...body, live }
    if (Buffer.byteLength(JSON.stringify(content)) > 256 * 1024) throw new MapReadError('map_source_too_large', { detail: 'limit' })
    return mapReadReply(content)
  }
  const parsed = sourceQuery.safeParse(raw)
  if (!parsed.success) throw new MapReadError('map_invalid_request', { detail: 'invalid_query', cause: parsed.error })
  const query = parsed.data
  let claims = query.cursor ? readMapToken(query.cursor, scope, ['source']) : undefined
  if (claims && claims.sourceRef !== sourceRef) throw new MapReadError('map_not_found')
  const handle = await resolveMapSource(scope, sourceRef)
  if (handle.availability === 'unavailable')
    return reply({ schemaVersion: 1, sourceRef, sourceKind: 'unavailable', availability: 'unavailable', locator: null, items: [], page: { nextCursor: null, hasMore: false } })
  const locator = handle.locator
  const makeClaims = (content: string): MapClaims => ({ ...snapshotClaims(scope, mapQuerySchema.parse({ workspaceId: scope.workspaceId }), content), kind: 'source', sourceRef })
  if (locator.type === 'run') {
    // resolveMapSource authorized this exact run in the same read-only snapshot.
    const runId = locator.id
    const watermark = (await pool.query('SELECT COALESCE(max(seq),-1) AS maximum,count(*) AS count FROM run_chunks WHERE "runId"=$1 AND ($2::integer IS NULL OR seq<=$2)', [runId, claims?.upperBound ?? null])).rows[0]
    const maximum = claims?.upperBound ?? Number(watermark.maximum)
    // Appended chunks stay outside this page series; a deleted original chunk
    // changes the count and requires a restart rather than hiding missing history.
    const digest = fingerprint([locator, maximum, Number(watermark.count)])
    if (claims && claims.fingerprint !== digest) throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
    claims ??= { ...makeClaims(digest), upperBound: maximum }
    // The first CTE limits metadata before byte accounting. Only bodies within the total
    // byte budget cross the database connection; an individual oversized record is explicit.
    const rows = (await pool.query(`WITH candidates AS (
        SELECT id,seq,octet_length(chunk::text) AS bytes FROM run_chunks
        WHERE "runId"=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4
      ), budget AS (SELECT *,sum(bytes) OVER (ORDER BY seq) AS total FROM candidates)
      SELECT b.id,b.seq,b.bytes,CASE WHEN b.total<=$5 THEN c.chunk ELSE NULL END AS chunk
      FROM budget b JOIN run_chunks c ON c.id=b.id ORDER BY b.seq LIMIT $4`,
      [runId, claims.offset ?? -1, maximum, query.limit + 1, 200 * 1024])).rows
    if (rows.length && rows[0].chunk === null) throw new MapReadError('map_source_too_large', { detail: 'limit' })
    const chosen = rows.filter(row => row.chunk !== null).slice(0, query.limit)
    const safe = await maskForRun(runId, chosen.map(row => ({ id: row.id, seq: row.seq, chunk: row.chunk })))
    const items = safe.map(row => ({ id: row.id, seq: row.seq, text: sanitizeSourceText(JSON.stringify(row.chunk)) }))
    while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > 240 * 1024) items.pop()
    if (Buffer.byteLength(JSON.stringify(items)) > 240 * 1024) throw new MapReadError('map_source_too_large', { detail: 'limit' })
    const offset = items.at(-1)?.seq ?? claims.offset ?? -1, hasMore = offset < maximum
    // A deleted tail cannot create an endless empty continuation.
    if (hasMore && items.length === 0) throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
    return reply({ schemaVersion: 1, sourceRef, sourceKind: 'run_chunks', availability: 'available', locator, items,
      page: { hasMore, nextCursor: hasMore ? signMapToken({ ...claims, offset }) : null } })
  }
  await assertSourceSize(locator)
  const source = await readDecisionSource(scope, locator, { maxChars: 131072 })
  if (source.truncated || Buffer.byteLength(source.text) > 128 * 1024) throw new MapReadError('map_source_too_large', { detail: 'limit' })
  const digest = fingerprint([source.locator, source.text])
  if (claims && claims.fingerprint !== digest) throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
  claims ??= makeClaims(digest)
  const start = claims.offset ?? 0
  if (start > source.text.length) throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
  let end = start, bytes = 0
  for (const point of source.text.slice(start)) {
    const size = Buffer.byteLength(point)
    if (bytes + size > 16 * 1024) break
    bytes += size; end += point.length
  }
  const hasMore = end < source.text.length
  return reply({ schemaVersion: 1, sourceRef, sourceKind: 'record', availability: 'available', locator: source.locator,
    items: [{ text: source.text.slice(start, end) }], page: { hasMore, nextCursor: hasMore ? signMapToken({ ...claims, offset: end }) : null } })
}

/** Check source size before invoking the existing authoritative loader, so it cannot
 * transfer a multi-megabyte original body just to return a clipped preview. */
async function assertSourceSize(locator: DecisionSourceLocator) {
  const statements: Record<Exclude<DecisionSourceLocator['type'], 'run'>, string> = {
    issue: 'SELECT octet_length(content::text)+octet_length(title) AS bytes FROM issues WHERE id=$1 LIMIT 1',
    run_chunk: 'SELECT octet_length(chunk::text) AS bytes FROM run_chunks WHERE id=$1 LIMIT 1',
    run_message: 'SELECT octet_length(text) AS bytes FROM run_messages WHERE id=$1 LIMIT 1',
    bot_message: 'SELECT octet_length(message::text) AS bytes FROM coordinator_messages WHERE id=$1 LIMIT 1',
    group_message: 'SELECT octet_length(body) AS bytes FROM conversation_messages WHERE id=$1 LIMIT 1',
    factory_task: 'SELECT octet_length(reason)+256 AS bytes FROM factory_tasks WHERE id=$1 LIMIT 1',
    attempt: 'SELECT octet_length(reason)+octet_length(output::text)+octet_length(evidence::text)+512 AS bytes FROM factory_attempts WHERE id=$1 LIMIT 1',
    candidate: 'SELECT octet_length(repository)+octet_length(environment)+octet_length(scope)+512 AS bytes FROM factory_candidates WHERE id=$1 LIMIT 1',
    commit: 'SELECT octet_length(repository)+octet_length(environment)+octet_length(scope)+512 AS bytes FROM factory_candidates WHERE id=$1 LIMIT 1',
    factory_event: 'SELECT octet_length(request::text)+octet_length(result::text) AS bytes FROM factory_events WHERE "eventId"=$1 AND "taskId"=$2 LIMIT 1',
    acceptance: 'SELECT 512 AS bytes FROM factory_deliverable_acceptances WHERE id=$1 LIMIT 1',
    question: 'SELECT octet_length(question)+octet_length(context)+octet_length(options::text)+octet_length(COALESCE(answer::text,\'\'))+512 AS bytes FROM factory_questions WHERE id=$1 LIMIT 1',
    answer: 'SELECT octet_length(question)+octet_length(context)+octet_length(options::text)+octet_length(COALESCE(answer::text,\'\'))+512 AS bytes FROM factory_questions WHERE id=$1 LIMIT 1',
    artifact_version: 'SELECT size+512 AS bytes FROM artifact_versions WHERE "artifactId"=$1 AND id=$2 LIMIT 1',
    pull_request: 'SELECT octet_length("pullRequest"::text) AS bytes FROM run_publications WHERE "runId"=$1 LIMIT 1',
  }
  if (locator.type === 'run') return
  const values = [locator.id, ...(locator.type === 'factory_event' ? [locator.taskId] : locator.type === 'artifact_version' ? [locator.versionId] : [])]
  const row = (await pool.query(statements[locator.type], values)).rows[0]
  if (!row) throw new MapReadError('map_not_found')
  if (row.bytes === null) throw new MapReadError('map_unavailable', { detail: 'database', cause: new Error('Source size is unavailable') })
  if (!Number.isSafeInteger(Number(row.bytes)) || Number(row.bytes) > MAP_SOURCE_BYTES) throw new MapReadError('map_source_too_large', { detail: 'limit' })
}
