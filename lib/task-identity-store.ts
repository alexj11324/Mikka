import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'

type Executor = Pick<typeof db, 'execute'>
export type TaskIdentityRef = { id: string; ownerId: string }
type IdentityRow = { id: string; userId: string; workspaceId: string | null; issuedIdentifier: string | null }
type TeamAlias = { issueId: string; workspaceId: string; ownerId: string; identifier: string; createdAt: Date | string }

/** One APP read and, only for pre-migration tasks, one bounded WS snapshot read.
 * No cross-database JOIN or distributed counter transaction is required. APP
 * row locks make concurrent first reads choose the same immutable identifier.
 * Callers must authorize the tasks before invoking this internal projection.
 */
export async function ensureTaskIdentifiers(tasks: readonly TaskIdentityRef[], executor: Executor = db): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  if (!tasks.length) return result
  const owners = new Map(tasks.map(task => [task.id, task.ownerId]))
  const ids = [...owners.keys()]
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const rows = (await executor.execute<IdentityRow>(sql`
      SELECT id, "userId", "workspaceId", "issuedIdentifier" FROM issues
      WHERE id IN (${sql.join(batch.map(id => sql`${id}::uuid`), sql`,`)})
    `)).rows.filter(row => row.userId === owners.get(row.id))
    const pending = rows.filter(row => row.workspaceId && !row.issuedIdentifier)
    for (const row of rows) result.set(row.id, row.issuedIdentifier)
    if (!pending.length) continue
    const { rows: candidates } = await workspacePool.query<TeamAlias>(`
      SELECT "issueId", "workspaceId", "ownerId", identifier, "createdAt"
      FROM mikka_task_identifier_aliases WHERE "issueId"=ANY($1::uuid[])
      ORDER BY "createdAt", identifier`, [pending.map(row => row.id)])
    const pendingById = new Map(pending.map(row => [row.id, row]))
    // A UUID match alone is not a tenant/owner proof. Imported aliases must
    // match the currently authorized APP task's exact tenant and creator.
    const aliases = candidates.filter(alias => {
      const task = pendingById.get(alias.issueId)
      return task?.workspaceId === alias.workspaceId && task.userId === alias.ownerId
    })
    if (aliases.length) await executor.execute(sql`
      INSERT INTO task_identifier_aliases ("issueId", "workspaceId", "ownerId", identifier, kind, "createdAt")
      SELECT a."issueId", a."workspaceId", a."ownerId", a.identifier, 'team', a."createdAt"
      FROM jsonb_to_recordset(${JSON.stringify(aliases)}::jsonb)
        AS a("issueId" uuid, "workspaceId" uuid, "ownerId" text, identifier text, "createdAt" timestamptz)
      JOIN issues i ON i.id=a."issueId" AND i."workspaceId"=a."workspaceId" AND i."userId"=a."ownerId"
      ON CONFLICT DO NOTHING
    `)
    const firstAlias = new Map<string, string>()
    for (const alias of aliases) if (!firstAlias.has(alias.issueId)) firstAlias.set(alias.issueId, alias.identifier)
    const input = pending.map(row => ({ id: row.id, alias: firstAlias.get(row.id) ?? null }))
    const issued = await executor.execute<{ id: string; identifier: string | null }>(sql`
      WITH ordered AS MATERIALIZED (
        SELECT id, alias FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS a(id uuid, alias text) ORDER BY id
      ) SELECT id, ensure_task_identifier(id, alias) AS identifier FROM ordered
    `)
    for (const row of issued.rows) result.set(row.id, row.identifier)
  }
  return result
}

/** An alias is a scoped lookup hint, never an access grant. Historical owners
 * could share a personal prefix. Preserve those links and reject ambiguity;
 * never silently pick an issue across creators or workspaces. The caller must
 * still run issueForUser/requireIssueAccess on a uniquely resolved UUID.
 */
export async function resolveTaskIdentifierAlias(input: { workspaceId: string; identifier: string; ownerId?: string }, executor: Executor = db) {
  const identifier = input.identifier.trim()
  if (!identifier || identifier.length > 256) return { kind: 'missing' as const }
  const ownerFilter = input.ownerId === undefined ? sql`` : sql`AND a."ownerId"=${input.ownerId}`
  const app = await executor.execute<{ issueId: string }>(sql`
    SELECT DISTINCT a."issueId" FROM task_identifier_aliases a
    JOIN issues i ON i.id=a."issueId" AND i."workspaceId"=a."workspaceId" AND i."userId"=a."ownerId"
    WHERE a."workspaceId"=${input.workspaceId}::uuid AND a.identifier=${identifier} ${ownerFilter}
    LIMIT 2
  `)
  const ws = await workspacePool.query<{ issueId: string; ownerId: string }>(`
    SELECT DISTINCT "issueId", "ownerId" FROM mikka_task_identifier_aliases
    WHERE "workspaceId"=$1 AND identifier=$2 AND ($3::text IS NULL OR "ownerId"=$3)`,
  [input.workspaceId, identifier, input.ownerId ?? null])
  // A WS alias can outlive a deleted task. Only APP rows in this exact tenant
  // participate, so stale WS rows cannot make a valid old link ambiguous.
  let liveWS: { id: string }[] = []
  if (ws.rows.length) liveWS = (await executor.execute<{ id: string }>(sql`
    SELECT DISTINCT i.id FROM jsonb_to_recordset(${JSON.stringify(ws.rows)}::jsonb) AS a("issueId" uuid, "ownerId" text)
    JOIN issues i ON i.id=a."issueId" AND i."userId"=a."ownerId"
    WHERE i."workspaceId"=${input.workspaceId}::uuid
  `)).rows
  const ids = new Set([...app.rows.map(row => row.issueId), ...liveWS.map(row => row.id)])
  if (!ids.size) return { kind: 'missing' as const }
  if (ids.size !== 1) return { kind: 'ambiguous' as const }
  return { kind: 'found' as const, issueId: [...ids][0] }
}
