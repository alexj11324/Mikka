import 'server-only'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/core'
import { db } from '@/lib/db'
import { linearIssueLinks, users } from '@/lib/db/schema'
import { issueWithMetadata } from '@/lib/issue-metadata'
import { FALLBACK_PERSONAL_PREFIX, resolvePersonalPrefix, taskIdentifier, type TaskScope } from '@/lib/task-identifier'

type Executor = Pick<typeof db, 'select'>
type TaskRef = { id: string; ownerId: string; scope: TaskScope; number?: number | null; prefixInput?: TaskPrefixInput | null }

/** Raw inputs from this operation's application-database read, never a cache. */
export type TaskPrefixInput = [saved: string | null, email: string, linearTeamKeys: string[] | null]

/** The caller supplies an explicitly qualified outer owner expression. Keeping
 * the inner alias literal avoids Drizzle's bare-column correlation bug (#1492). */
export function taskPrefixInput(ownerId: SQL) {
  return sql<TaskPrefixInput | null>`(select jsonb_build_array(p.prefix,u.email,(select array_agg(l."linearTeamKey") from linear_team_syncs l where l."ownerId"=u.id)) from "user" u left join issue_prefixes p on p."userId"=u.id where u.id=${ownerId})`
}

/** Prefetch a personal prefix for the reader's own unlinked tasks. Other
 * authorized owners use taskIdentifiers' bounded fallback read. A positive
 * link may skip an unused prefix; its absence never proves unlinking. */
export function taskPrefixOwner(userId: string, linkedIds: readonly string[]) {
  return sql<string | null>`case when issues."userId" = ${userId}
    and (issues.scope = 'personal' or not (issues.id = any(${`{${linkedIds.join(',')}}`}::uuid[])))
    then issues."userId" end`
}

/** Apply after the caller's authorization and LIMIT. One input per owner in
 * this page, ordered like the page so a lookahead row cannot consume its input. */
export function pageTaskPrefixInput(ownerId: SQL, orderBy: SQL) {
  return sql<TaskPrefixInput | null>`case when ${ownerId} is not null
    and row_number() over (partition by ${ownerId} order by ${orderBy}) = 1
    then ${taskPrefixInput(ownerId)} end`
}


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

/** `taskIdentifier` for many tasks at once, keyed by task id. `knownTeams` may
 * reuse a complete link read made by this same operation, never a held cache. */
export async function taskIdentifiers(tasks: TaskRef[], executor: Executor = db, knownTeams?: ReadonlyMap<string, { key: string; number: number }>) {
  const result = new Map<string, string | null>()
  if (!tasks.length) return result
  const workspaceIds = tasks.filter(task => task.scope === 'workspace').map(task => task.id)
  const teams = knownTeams ?? await teamNumbers(workspaceIds)
  // Legacy imports and an explicitly removed team can leave a workspace task
  // unlinked. Naming it must not change its scope, membership or Linear alias.
  // Fetch these owners with personal-task owners in the same bounded batch;
  // a normal team-only dispatch still makes no personal-prefix query.
  const ownerIds = tasks.filter(task => task.scope === 'personal' || !teams.has(task.id)).map(task => task.ownerId)
  const supplied = new Map(tasks.flatMap(task => task.prefixInput ? [[task.ownerId, task.prefixInput] as const] : []))
  const prefixes = await personalPrefixes(ownerIds.filter(ownerId => !supplied.has(ownerId)), executor)
  for (const ownerId of new Set(ownerIds)) {
    const input = supplied.get(ownerId)
    if (input) prefixes.set(ownerId, resolvePersonalPrefix({ saved: input[0], email: input[1], linearTeamKeys: input[2] ?? [] }))
  }
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
export async function issueView<T extends { id: string; userId: string; scope: TaskScope; content: JSONContent; linearSyncPolicy?: string }>(issue: T, executor: Executor = db, knownTeams?: ReadonlyMap<string, { key: string; number: number }>) {
  const view = issueWithMetadata(issue)
  // The assignee is a snapshot from when they were assigned; show the person as they are now (R-36: one avatar per person).
  const assignee = view.metadata.assignee
  if (assignee?.kind === 'member') {
    const [person] = await executor.select({ name: users.name, image: users.image }).from(users).where(eq(users.id, assignee.id)).limit(1)
    if (person) view.metadata.assignee = { ...assignee, name: person.name, image: person.image }
  }
  const teams = knownTeams ?? await teamNumbers(issue.scope === 'workspace' ? [issue.id] : [])
  let prefixInput: TaskPrefixInput | null = null
  let linearTargetVerified = false
  if (issue.linearSyncPolicy === 'explicit') {
    if (issue.scope === 'workspace' && teams.has(issue.id)) {
      const [verified] = await executor.select({ id: linearIssueLinks.id }).from(linearIssueLinks)
        .where(and(eq(linearIssueLinks.issueId, issue.id), eq(linearIssueLinks.ownerId, issue.userId), eq(linearIssueLinks.externalTargetVerified, true))).limit(1)
      linearTargetVerified = Boolean(verified)
    } else {
      // Reuse the explicit verification read for this task's personal or
      // unlinked prefix. Both correlations stay qualified in the projection.
      const [dependencies] = await executor.select({
        prefixInput: taskPrefixInput(sql`"user".id`),
        verified: sql<boolean>`exists (select 1 from linear_issue_links v where v."issueId" = ${issue.id}
          and v."ownerId" = "user".id and v."externalTargetVerified" = true)`,
      }).from(users).where(eq(users.id, issue.userId))
      prefixInput = dependencies?.prefixInput ?? null
      linearTargetVerified = Boolean(dependencies?.verified)
    }
  }
  const identifiers = await taskIdentifiers([{ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: view.metadata.number, prefixInput }], executor, teams)
  return { ...view, identifier: identifiers.get(issue.id) ?? null, linearTargetVerified }
}
