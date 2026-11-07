import type { Pool, PoolClient, QueryResultRow } from 'pg'

/** A catalogue page, not a timer: each SQL read returns at most 128 options. */
export const EXECUTION_MODEL_PAGE_SIZE = 128
type Query = Pick<Pool | PoolClient, 'query'>
type Scope = { ownerId: string; workspaceId: string }
type Cursor = { preferred: boolean; at: string; id: string }
type PageRow = QueryResultRow & { _preferred: boolean; _at: string; _id: string }

const fullColumns = `b.id AS "bindingId",b."ownerId",b."consumerId",b."workspaceId",b."modelId",b.route,
  c.id AS "connectionId",c.provider,c."accountLabel",c.quota->>'plan' AS plan,c.quota`
const catalogueColumns = `b."ownerId",b."modelId",c.id AS "connectionId",c.provider`
const connected = `FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
  AND c.epoch=b."connectionRevision" AND c.state='connected' AND c.paused=false AND c."removedAt" IS NULL
  WHERE b."ownerId"=$1 AND b.route IN ('codex_cpa','claude_cpa','openai_siwc')`

/** Saved binding lookup is exact and independent of catalogue deduplication. */
export async function executionBinding(query: Query, scope: Scope, bindingId: string) {
  return (await query.query(`SELECT ${fullColumns} ${connected} AND b.id=$2 LIMIT 1`, [scope.ownerId, bindingId])).rows[0]
}

/**
 * Choose the same first binding per account/model as the former JS filter,
 * before duplicate Bot copies and repeated quota cross the database connection.
 * Settings' candidate list needs only four public catalogue columns. Runtime
 * lookups and chat availability keep their full, exact subscription snapshot.
 */
export async function executionModelOptions(query: Query, scope: Scope, catalogue = false) {
  const rows: QueryResultRow[] = []
  let cursor: Cursor | null = null
  for (;;) {
    const page: PageRow[] = (await query.query<PageRow>(`WITH choices AS (
      SELECT DISTINCT ON (c.id,b."modelId") ${catalogue ? catalogueColumns : fullColumns},
        (b."workspaceId"=$2) AS "_preferred",b."createdAt"::text AS "_at",b.id AS "_id"
      ${connected}
        AND (c."modelCatalog" IS NULL OR c."modelCatalog"->>'revision'<>c.epoch::text OR c."modelCatalog"->'models' ? b."modelId")
      ORDER BY c.id,b."modelId",(b."workspaceId"=$2) DESC,b."createdAt" DESC,b.id
    ) SELECT * FROM choices
      WHERE ($3::boolean IS NULL OR "_preferred"<$3
        OR ("_preferred"=$3 AND "_at"::timestamptz<$4::timestamptz)
        OR ("_preferred"=$3 AND "_at"::timestamptz=$4::timestamptz AND "_id">$5::uuid))
      ORDER BY "_preferred" DESC,"_at"::timestamptz DESC,"_id" LIMIT $6`,
    [scope.ownerId, scope.workspaceId, cursor?.preferred ?? null, cursor?.at ?? null, cursor?.id ?? null, EXECUTION_MODEL_PAGE_SIZE])).rows
    for (const { _preferred, _at, _id, ...row } of page) rows.push(row)
    if (page.length < EXECUTION_MODEL_PAGE_SIZE) return rows
    const last = page.at(-1)!
    // PostgreSQL text retains microseconds; converting through JS Date would
    // lose the ordering of options created within the same millisecond.
    cursor = { preferred: last._preferred, at: last._at, id: last._id }
  }
}
