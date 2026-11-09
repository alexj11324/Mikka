import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/core'
import { db } from '@/lib/db'
import { linearIssueLinks, users } from '@/lib/db/schema'
import { issueWithMetadata, type IssueMetadata } from '@/lib/issue-metadata'
import { resolvePersonalPrefix, type TaskScope } from '@/lib/task-identifier'
import { ensureTaskIdentifiers } from '@/lib/task-identity-store'
import { projectViewsForTasks } from '@/lib/project-access'

type Executor = Pick<typeof db, 'select' | 'execute'>
type TaskRef = { id: string; ownerId: string; scope: TaskScope; number?: number | null; issuedIdentifier?: string | null }

/** Each owner's resolved personal prefix. One query: the owner's email, saved prefix and Linear team keys. */
export async function personalPrefixes(ownerIds: string[], executor: Executor = db) {
  const ids = [...new Set(ownerIds)]
  const result = new Map<string, string>()
  if (!ids.length) return result
  const owners = await executor.select({
    id: users.id, email: users.email,
    // Explicit aliases: inside a selected field drizzle drops table names from column references.
    saved: sql<string | null>`(select p.prefix from issue_prefixes p where p."userId" = "user".id)`,
    keys: sql<string[] | null>`(select array_agg(l."linearTeamKey") from linear_team_syncs l where l."ownerId" = "user".id)`,
  }).from(users).where(inArray(users.id, ids))
  for (const owner of owners) result.set(owner.id, resolvePersonalPrefix({ saved: owner.saved, email: owner.email, linearTeamKeys: owner.keys ?? [] }))
  return result
}

/** Each workspace task's team key and number in that team (workspace database). */
export async function teamNumbers(issueIds: string[]) {
  const result = new Map<string, { key: string; number: number }>()
  if (!issueIds.length) return result
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows } = await workspacePool.query<{ issueId: string; key: string; number: string }>(
    'SELECT l."issueId", t.identifier AS key, l.number FROM mikka_team_issues l JOIN mikka_teams t ON t.id=l."teamId" WHERE l."issueId" = ANY($1::uuid[])', [issueIds])
  for (const row of rows) result.set(row.issueId, { key: row.key, number: Number(row.number) })
  return result
}

/** Current responsibility is nullable active membership, while the metadata
 * and issue_versions retain the historical assignment for audit. Reads never
 * grant access merely because someone was previously assigned to the task. */
export async function taskAssignees(tasks: readonly { id: string; workspaceId: string | null; assignee: IssueMetadata['assignee'] }[], executor: Pick<typeof db, 'select'> = db) {
  type Member = { kind: 'member'; id: string; name: string; image: string | null }
  const result = new Map<string, Member | null>(tasks.map(task => [task.id, null]))
  const references = tasks.flatMap(task => task.workspaceId && task.assignee?.kind === 'member'
    ? [{ issueId: task.id, workspaceId: task.workspaceId, userId: task.assignee.id }] : [])
  if (!references.length) return result
  const { workspacePool } = await import('@/lib/workspace-db')
  for (let offset = 0; offset < references.length; offset += 200) {
    const batch = references.slice(offset, offset + 200)
    const { rows } = await workspacePool.query<{ issueId: string; userId: string }>(`
      SELECT a."issueId", a."userId" FROM jsonb_to_recordset($1::jsonb)
        AS a("issueId" uuid, "workspaceId" uuid, "userId" text)
      JOIN mikka_workspace_members m ON m."workspaceId"=a."workspaceId" AND m."userId"=a."userId" AND m.status='active'
      JOIN mikka_workspaces w ON w.id=m."workspaceId"
      WHERE w.kind='team' OR (w.kind='personal' AND w."userId"=a."userId")`, [JSON.stringify(batch)])
    if (!rows.length) continue
    const people = await executor.select({ id: users.id, name: users.name, image: users.image }).from(users)
      .where(inArray(users.id, [...new Set(rows.map(row => row.userId))]))
    const current = new Map(people.map(person => [person.id, person]))
    for (const row of rows) {
      const person = current.get(row.userId)
      if (person) result.set(row.issueId, { ...person, kind: 'member' })
    }
  }
  return result
}

/** Reuse immutable identifiers from this operation's authorized APP projection,
 * never client input or a cached owner/Team prefix. Legacy rows without an
 * issued value keep the existing UUID/owner checks and scoped alias import.
 * The third argument remains a compatibility input; Team links do not name
 * an already issued Task or grant it access. */
export async function taskIdentifiers(tasks: TaskRef[], executor: Executor = db, _knownTeams?: ReadonlyMap<string, { key: string; number: number }>) {
  const result = new Map<string, string | null>()
  const pending: TaskRef[] = []
  for (const task of new Map(tasks.map(task => [task.id, task])).values()) {
    if (typeof task.issuedIdentifier === 'string' && task.issuedIdentifier.length > 0) result.set(task.id, task.issuedIdentifier)
    else pending.push(task)
  }
  for (const [id, identifier] of await ensureTaskIdentifiers(pending, executor)) result.set(id, identifier)
  return result
}

/** An issue row as the client sees it: metadata plus its display identifier. */
export async function issueView<T extends { id: string; userId: string; workspaceId: string | null; scope: TaskScope; content: JSONContent; linearSyncPolicy?: string; issuedIdentifier?: string | null }>(issue: T, executor: Executor = db, _knownTeams?: ReadonlyMap<string, { key: string; number: number }>) {
  const view = issueWithMetadata(issue)
  view.metadata.assignee = (await taskAssignees([{ id: issue.id, workspaceId: issue.workspaceId, assignee: view.metadata.assignee }], executor)).get(issue.id) ?? null
  const identifier = issue.issuedIdentifier ?? (await taskIdentifiers([{ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: view.metadata.number }], executor)).get(issue.id) ?? null
  const project = (await projectViewsForTasks([issue])).get(issue.id)
  view.metadata.project = project?.project ?? null
  const [verified] = issue.linearSyncPolicy === 'explicit' ? await executor.select({ id: linearIssueLinks.id }).from(linearIssueLinks)
    .where(and(eq(linearIssueLinks.issueId, issue.id), eq(linearIssueLinks.ownerId, issue.userId), eq(linearIssueLinks.externalTargetVerified, true))).limit(1) : []
  return { ...view, issuedIdentifier: identifier, identifier, projectId: project?.projectId ?? null, linearTargetVerified: Boolean(verified) }
}
