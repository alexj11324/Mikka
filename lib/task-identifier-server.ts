import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/core'
import { db } from '@/lib/db'
import { linearIssueLinks, users } from '@/lib/db/schema'
import { issueWithMetadata } from '@/lib/issue-metadata'
import { FALLBACK_PERSONAL_PREFIX, resolvePersonalPrefix, taskIdentifier, type TaskScope } from '@/lib/task-identifier'

type Executor = Pick<typeof db, 'select'>
type TaskRef = { id: string; ownerId: string; scope: TaskScope; number?: number | null }

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

/** `taskIdentifier` for many tasks at once, keyed by task id. */
export async function taskIdentifiers(tasks: TaskRef[], executor: Executor = db) {
  const result = new Map<string, string | null>()
  if (!tasks.length) return result
  const workspaceIds = tasks.filter(task => task.scope === 'workspace').map(task => task.id)
  const personalOwners = tasks.filter(task => task.scope === 'personal').map(task => task.ownerId)
  const [teams, prefixes] = await Promise.all([teamNumbers(workspaceIds), personalPrefixes(personalOwners, executor)])
  for (const task of tasks) {
    result.set(task.id, taskIdentifier({
      scope: task.scope,
      number: task.number,
      team: teams.get(task.id),
      personalPrefix: prefixes.get(task.ownerId) ?? FALLBACK_PERSONAL_PREFIX,
    }))
  }
  return result
}

/** An issue row as the client sees it: metadata plus its display identifier. */
export async function issueView<T extends { id: string; userId: string; scope: TaskScope; content: JSONContent }>(issue: T, executor: Executor = db) {
  const view = issueWithMetadata(issue)
  // The assignee is a snapshot from when they were assigned; show the person as they are now (R-36: one avatar per person).
  const assignee = view.metadata.assignee
  if (assignee?.kind === 'member') {
    const [person] = await executor.select({ name: users.name, image: users.image }).from(users).where(eq(users.id, assignee.id)).limit(1)
    if (person) view.metadata.assignee = { ...assignee, name: person.name, image: person.image }
  }
  const identifiers = await taskIdentifiers([{ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: view.metadata.number }], executor)
  const [verified] = issue.scope === 'workspace' ? await executor.select({ id: linearIssueLinks.id }).from(linearIssueLinks)
    .where(and(eq(linearIssueLinks.issueId, issue.id), eq(linearIssueLinks.ownerId, issue.userId), eq(linearIssueLinks.externalTargetVerified, true))).limit(1) : []
  return { ...view, identifier: identifiers.get(issue.id) ?? null, linearTargetVerified: Boolean(verified) }
}
