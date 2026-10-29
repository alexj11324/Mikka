import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/core'
import { db } from '@/lib/db'
import { issuePrefixes, linearIssueLinks, linearTeamSyncs, users } from '@/lib/db/schema'
import { issueWithMetadata } from '@/lib/issue-metadata'
import { resolvePersonalPrefix, taskIdentifier, type TaskScope } from '@/lib/task-identifier'

type Executor = Pick<typeof db, 'select'>
type TaskRef = { id: string; ownerId: string; scope: TaskScope; number?: number | null }

/** Each owner's resolved personal prefix (null when they still have to choose one). */
export async function personalPrefixes(ownerIds: string[], executor: Executor = db) {
  const ids = [...new Set(ownerIds)]
  const result = new Map<string, string | null>()
  if (!ids.length) return result
  const [owners, saved, teams] = await Promise.all([
    executor.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids)),
    executor.select({ userId: issuePrefixes.userId, prefix: issuePrefixes.prefix }).from(issuePrefixes).where(inArray(issuePrefixes.userId, ids)),
    executor.select({ ownerId: linearTeamSyncs.ownerId, key: linearTeamSyncs.linearTeamKey }).from(linearTeamSyncs).where(inArray(linearTeamSyncs.ownerId, ids)),
  ])
  for (const owner of owners) {
    result.set(owner.id, resolvePersonalPrefix({
      saved: saved.find(row => row.userId === owner.id)?.prefix,
      email: owner.email,
      linearTeamKeys: teams.filter(team => team.ownerId === owner.id).map(team => team.key),
    }))
  }
  return result
}

/** `taskIdentifier` for many tasks at once, keyed by task id. */
export async function taskIdentifiers(tasks: TaskRef[], executor: Executor = db) {
  const result = new Map<string, string | null>()
  if (!tasks.length) return result
  const workspaceIds = tasks.filter(task => task.scope === 'workspace').map(task => task.id)
  const personalOwners = tasks.filter(task => task.scope === 'personal').map(task => task.ownerId)
  const [links, prefixes] = await Promise.all([
    workspaceIds.length ? executor.select({ issueId: linearIssueLinks.issueId, identifier: linearIssueLinks.linearIdentifier }).from(linearIssueLinks).where(inArray(linearIssueLinks.issueId, workspaceIds)) : [],
    personalPrefixes(personalOwners, executor),
  ])
  for (const task of tasks) {
    result.set(task.id, taskIdentifier({
      scope: task.scope,
      number: task.number,
      linearIdentifier: links.find(link => link.issueId === task.id)?.identifier,
      personalPrefix: prefixes.get(task.ownerId),
    }))
  }
  return result
}

/** An issue row as the client sees it: metadata plus its display identifier. */
export async function issueView<T extends { id: string; userId: string; scope: TaskScope; content: JSONContent }>(issue: T, executor: Executor = db) {
  const view = issueWithMetadata(issue)
  const identifiers = await taskIdentifiers([{ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: view.metadata.number }], executor)
  const [verified] = issue.scope === 'workspace' ? await executor.select({ id: linearIssueLinks.id }).from(linearIssueLinks)
    .where(and(eq(linearIssueLinks.issueId, issue.id), eq(linearIssueLinks.ownerId, issue.userId), eq(linearIssueLinks.externalTargetVerified, true))).limit(1) : []
  return { ...view, identifier: identifiers.get(issue.id) ?? null, linearTargetVerified: Boolean(verified) }
}
