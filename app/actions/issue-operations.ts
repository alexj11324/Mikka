'use server'

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import { db } from '@/lib/db'
import { issueListChanged } from '@/lib/live/lists'
import { issueRelationsChanged, relationIds } from '@/lib/live/issue-detail'
import { issues, issueMembers, issueVersions } from '@/lib/db/schema'
import { requireIssueAccess, requireIssueAccessWithoutBody } from '@/lib/issue-access'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { issueView, taskIdentifiers } from '@/lib/task-identifier-server'
import { readIssueMetadata, withIssueMetadata, type IssueMetadata } from '@/lib/issue-metadata'
import { allocateIssueNumbers } from '@/lib/issue-numbering'
import { createsIssueCycle } from '@/lib/issue-relations'
import { dispatchLinearIssueSync, dispatchLinearWork } from '@/lib/linear-sync/dispatch'
import { activityActor } from '@/lib/activity-actor'
import { requireCurrentIssueWorkspace, requireLockedIssueScope, withIssueWorkspace } from '@/lib/issue-scope-authorization'

const relationSchema = z.object({ id: z.uuid(), revision: z.number().int().positive(), targetId: z.uuid().nullable(), kind: z.enum(['parent', 'child', 'related', 'blockedBy', 'blocks', 'duplicate']), remove: z.boolean().default(false) })

/**
 * Runs after the write has committed. Scheduling Linear sync can throw (e.g. `after` outside a
 * request); that must not turn a saved change into a "save failed" response, so it only logs.
 */
function scheduleLinearWork() {
  try { dispatchLinearWork() }
  catch (error) { console.error('Linear background sync could not be scheduled', error instanceof Error ? error.name : 'UnknownError') }
}

/** The task's relations panel and subtasks: the task itself and the tasks it links to or that link to it. */
export async function listIssueConnections(id: string) {
  return issueConnections(id, 'linked')
}

/**
 * `linked`: only the task, the tasks its metadata names (parent, blocked by,
 * related, duplicate of) and the tasks whose metadata names it, found in SQL;
 * every other task of the owner stays in Postgres. `all`: every task of the
 * owner, for copying a whole subtask tree.
 */
async function issueConnections(id: string, reach: 'linked' | 'all') {
  const { issue, user, teamId } = await requireIssueAccessWithoutBody(id, { projection: 'lock' })
  return db.transaction(async tx => {
  const [locked] = await tx.select({ workspaceId: issues.workspaceId, scopeVersion: issues.scopeVersion, content: issueAttrsContent }).from(issues).where(eq(issues.id, id)).for('share')
  requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
  await requireCurrentIssueWorkspace(user, issue.workspaceId)
  let related: SQL | undefined
  if (reach === 'linked') {
    const own = readIssueMetadata(locked.content)
    const named = [...new Set([own.parentId, own.duplicateOfId, ...own.blockedByIds, ...own.relatedIds].filter((value): value is string => !!value))]
    // Both metadata keys (readIssueMetadata reads `mikka`, else the pre-rename `orvilo`): a superset, narrowed by the same JS filters.
    const namesTask = (key: 'mikka' | 'orvilo') => {
      const metadata = sql`${issues.content}->'attrs'->${sql.raw(`'${key}'`)}`
      return sql`(${metadata}->>'parentId' = ${id} or ${metadata}->'blockedByIds' ? ${id} or ${metadata}->'relatedIds' ? ${id})`
    }
    related = or(eq(issues.id, id), named.length ? inArray(issues.id, named) : undefined, namesTask('mikka'), namesTask('orvilo'))
  }
  // Only each row's metadata is used: read the body's attrs, never every task's whole body.
  // Reuse the locked task's freshly checked tenant; team links only name rows.
  const rows = await tx.select({ id: issues.id, ownerId: issues.userId, title: issues.title, status: issues.status, priority: issues.priority, scope: issues.scope, workspaceId: issues.workspaceId, scopeVersion: issues.scopeVersion, revision: issues.revision, content: issueAttrsContent, createdAt: issues.createdAt }).from(issues)
    .where(and(eq(issues.userId, issue.userId), related, issueVisibilityPredicate(user.id, { allowedIds: [], workspaceIds: [issue.workspaceId!] }))).orderBy(desc(issues.updatedAt))
  const live = rows.filter(row => !readIssueMetadata(row.content).deletedAt)
  // The entry lookup is complete for this one task. Its missing link is only
  // a same-operation naming fact; larger relation sets need their full read.
  const knownTeams = reach === 'linked' && !teamId && live.length === 1 && live[0].id === id
    ? new Map<string, { key: string; number: number }>() : undefined
  // The private whole-owner copy consumes structure only; labels belong to the public linked view.
  const identifiers = reach === 'linked'
    ? await taskIdentifiers(live.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: readIssueMetadata(row.content).number })), tx, knownTeams)
    : new Map<string, string | null>()
  return live.map(({ content, ...row }) => ({ ...row, identifier: identifiers.get(row.id) ?? null, metadata: readIssueMetadata(content) }))
  })
}

export async function updateIssueRelation(input: z.input<typeof relationSchema>) {
  return runAction(async () => {
    const parsed = relationSchema.safeParse(input)
    if (!parsed.success) return { error: 'issueRelationInvalid' }
    const value = parsed.data
    const { issue, user } = await requireIssueAccess(value.id)
    const target = value.targetId ? (await requireIssueAccess(value.targetId)).issue : null
    if (target?.id === issue.id) return { error: 'issueSelfLink' }
    if (target && target.workspaceId !== issue.workspaceId) return { error: 'issueTargetUnavailable' }
    if (target && target.userId !== issue.userId) return { error: 'issueCrossOwner' }
    if (!target && value.kind !== 'parent') return { error: 'issueTargetRequired' }
    try {
      const result = await withIssueWorkspace(user, issue.workspaceId, () => db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${issue.userId}, 0))`)
        // The owner advisory lock serializes graph edits, including disjoint edges
        // that would jointly close a cycle. Only the two rows we may update need
        // row locks; the rest of the graph is an ordinary MVCC read.
        const rows = await tx.select().from(issues).where(and(eq(issues.userId, issue.userId), inArray(issues.id, [issue.id, ...(target ? [target.id] : [])]))).orderBy(issues.id).for('update')
        const current = rows.find(row => row.id === issue.id)
        const other = rows.find(row => row.id === target?.id)
        requireLockedIssueScope(current, user.id, issue.scopeVersion, issue.workspaceId)
        if (target) requireLockedIssueScope(other, user.id, target.scopeVersion, target.workspaceId)
        if (!current || current.revision !== value.revision || readIssueMetadata(current.content).deletedAt) return { error: 'issueOutdated' }
        if (target && (!other || readIssueMetadata(other.content).deletedAt)) return { error: 'issueTargetUnavailable' }
        const graphRows = value.kind !== 'related' && !value.remove && other
          ? await tx.select({ id: issues.id, content: issueAttrsContent }).from(issues).where(eq(issues.userId, issue.userId))
          : []
        const metadata = readIssueMetadata(current.content)
        const targetMetadata = other ? readIssueMetadata(other.content) : null
        const patches = new Map<string, { metadata: IssueMetadata; status?: string }>()
        const update = (id: string, patch: Partial<IssueMetadata>, status?: string) => {
          const row = rows.find(row => row.id === id)!
          patches.set(id, { metadata: { ...readIssueMetadata(row.content), ...patches.get(id)?.metadata, ...patch }, status })
        }
        const toggle = (ids: string[], id: string) => value.remove ? ids.filter(item => item !== id) : [...new Set([...ids, id])]
        if (value.kind === 'parent' || value.kind === 'child') {
          const child = value.kind === 'child' ? other! : current
          const parentId = value.remove || !other ? null : value.kind === 'child' ? current.id : other.id
          const graph = new Map(graphRows.map(row => [row.id, readIssueMetadata(row.content).parentId ? [readIssueMetadata(row.content).parentId!] : []]))
          if (parentId && createsIssueCycle(child.id, [parentId], graph)) return { error: 'issueParentCycle' }
          update(child.id, { parentId })
        } else if (value.kind === 'related') {
          update(current.id, { relatedIds: toggle(metadata.relatedIds, other!.id) })
          update(other!.id, { relatedIds: toggle(targetMetadata!.relatedIds, current.id) })
        } else if (value.kind === 'duplicate') {
          if (!value.remove && createsIssueCycle(current.id, [other!.id], new Map(graphRows.map(row => [row.id, readIssueMetadata(row.content).duplicateOfId ? [readIssueMetadata(row.content).duplicateOfId!] : []])))) return { error: 'issueDuplicateCycle' }
          update(current.id, { duplicateOfId: value.remove ? null : other!.id }, value.remove ? 'todo' : 'duplicate')
        } else {
          const blocked = value.kind === 'blocks' ? other! : current
          const blocker = value.kind === 'blocks' ? current : other!
          const blockedMetadata = readIssueMetadata(blocked.content)
          const next = toggle(blockedMetadata.blockedByIds, blocker.id)
          const graph = new Map(graphRows.map(row => [row.id, readIssueMetadata(row.content).blockedByIds]))
          if (!value.remove && createsIssueCycle(blocked.id, next, graph)) return { error: 'issueBlockCycle' }
          update(blocked.id, { blockedByIds: next })
        }
        if (!patches.has(current.id)) update(current.id, {})
        if ([...patches.values()].some(patch => patch.metadata.blockedByIds.length > 100 || patch.metadata.relatedIds.length > 100)) return { error: 'issueRelationLimit' }
        let savedCurrent = current
        for (const [id, patch] of patches) {
          const row = rows.find(row => row.id === id)!
          const [saved] = await tx.update(issues).set({ content: withIssueMetadata(row.content, patch.metadata), status: patch.status ?? row.status, revision: row.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, issue.userId))).returning()
          await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: issue.userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...activityActor(user.id) })
          await issueListChanged(tx, saved.id)
          if (id === current.id) savedCurrent = saved
        }
        // Both ends, and any task an edit disconnected (its old parent): their lists change.
        await issueRelationsChanged(tx, [...patches.keys()].flatMap(id => [id, ...relationIds(rows.find(row => row.id === id)!.content)]))
        return { issue: await issueView(savedCurrent, tx) }
      }))
      if ('issue' in result) scheduleLinearWork()
      return result
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      return { error: 'issueRelationSaveFailed' }
    }
  })
}

export async function createLinkedIssue(input: { id: string; revision: number; kind: 'child' | 'duplicate'; title?: string; includeSubissues?: boolean }) {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), kind: z.enum(['child', 'duplicate']), title: z.string().trim().min(1).max(200).optional(), includeSubissues: z.boolean().optional() }).safeParse(input)
    if (!parsed.success) return { error: 'issueTitleInvalid' }
    const t = await getTranslations('IssueDetail')
    const { issue, user } = await requireIssueAccessWithoutBody(input.id, { projection: 'lock' })
    if (!issue.workspaceId || issue.ownershipState !== 'bound') throw new ActionFailureError('workspaceAccessDenied')
    const accessible = input.includeSubissues ? await issueConnections(issue.id, 'all') : []
    try {
      const result = await withIssueWorkspace(user, issue.workspaceId, workspace => db.transaction(async tx => {
        for (const owner of [...new Set([issue.userId, user.id])].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`)
        const [source] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
        requireLockedIssueScope(source, user.id, issue.scopeVersion, issue.workspaceId)
        if (!source || source.revision !== input.revision || readIssueMetadata(source.content).deletedAt) return { error: 'issueOutdated' }
        const metadata = readIssueMetadata(source.content)
        const child = input.kind === 'child'
        if (child && !parsed.data.title) return { error: 'issueChildTitleRequired' }
        const ownerId = child ? source.userId : user.id
        const number = await allocateIssueNumbers(tx, ownerId)
        const newMetadata = { ...metadata, number, parentId: child ? source.id : null, blockedByIds: [], relatedIds: [], duplicateOfId: null, favoriteUserIds: [], subscriberUserIds: [], deletedAt: null, assignee: child || source.userId === user.id ? metadata.assignee : null }
        const ownership = { workspaceId: workspace.id, ownershipState: 'bound' as const, scope: workspace.kind === 'personal' ? 'personal' as const : 'workspace' as const, scopeSetBy: 'user' as const, linearSyncPolicy: 'disabled' as const, linearSyncBlocked: true }
        const [created] = await tx.insert(issues).values({ id: crypto.randomUUID(), userId: ownerId, ...ownership, title: parsed.data.title ?? t('defaultDuplicateTitle', { title: source.title.slice(0, 195) }), content: withIssueMetadata(child ? { type: 'doc', content: [{ type: 'paragraph' }] } : source.content, newMetadata), status: 'todo', priority: source.priority, revision: 1 }).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: created.id, userId: ownerId, revision: 1, title: created.title, content: created.content, status: created.status, priority: created.priority, ...activityActor(user.id) })
        await issueListChanged(tx, created.id)
        await issueRelationsChanged(tx, [created.id, source.id])
        if (child) {
          const members = await tx.select({ memberId: issueMembers.memberId }).from(issueMembers).where(and(eq(issueMembers.issueId, source.id), eq(issueMembers.userId, source.userId)))
          if (members.length) await tx.insert(issueMembers).values(members.map(member => ({ issueId: created.id, userId: ownerId, memberId: member.memberId })))
        } else if (input.includeSubissues) {
          const mapping = new Map([[source.id, created.id]])
          const queue = [source.id]
          while (queue.length) {
            const parentId = queue.shift()!
            for (const item of accessible.filter(row => row.metadata.parentId === parentId && !mapping.has(row.id))) {
              const [original] = await tx.select().from(issues).where(and(eq(issues.id, item.id), eq(issues.userId, source.userId))).for('update')
              if (!original || original.workspaceId !== workspace.id || original.ownershipState !== 'bound' || original.scopeVersion !== item.scopeVersion) continue
              const currentMetadata = readIssueMetadata(original.content)
              if (currentMetadata.deletedAt || currentMetadata.parentId !== parentId) continue
              const id = crypto.randomUUID()
              const copyMetadata = { ...currentMetadata, number: await allocateIssueNumbers(tx, ownerId), parentId: mapping.get(parentId)!, blockedByIds: [], relatedIds: [], duplicateOfId: null, favoriteUserIds: [], subscriberUserIds: [], deletedAt: null, assignee: source.userId === user.id ? currentMetadata.assignee : null }
              // The child copy is consumed only by its version snapshot and invalidation.
              // Read the stored values after triggers without returning unused task columns.
              const [copy] = await tx.insert(issues).values({ id, userId: ownerId, ...ownership, title: original.title, content: withIssueMetadata(original.content, copyMetadata), status: 'todo', priority: original.priority, revision: 1 })
                .returning({ id: issues.id, title: issues.title, content: issues.content, status: issues.status, priority: issues.priority })
              await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: ownerId, revision: 1, title: copy.title, content: copy.content, status: copy.status, priority: copy.priority, ...activityActor(user.id) })
              await issueListChanged(tx, copy.id)
              mapping.set(item.id, id); queue.push(item.id)
            }
          }
        }
        return { issue: await issueView(created, tx) }
      }))
      if ('issue' in result) scheduleLinearWork()
      return result
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      return { error: 'issueCreateFailed' }
    }
  })
}

export async function toggleIssuePreference(input: { id: string; kind: 'favorite' | 'subscribe' }) {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), kind: z.enum(['favorite', 'subscribe']) }).safeParse(input)
    if (!parsed.success) return { error: 'issueOperationInvalid' }
    const { issue, user } = await requireIssueAccess(input.id)
    try {
      return await withIssueWorkspace(user, issue.workspaceId, () => db.transaction(async tx => {
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
        requireLockedIssueScope(latest, user.id, issue.scopeVersion, issue.workspaceId)
        if (!latest || readIssueMetadata(latest.content).deletedAt) return { error: 'issueUnavailable' }
        const metadata = readIssueMetadata(latest.content)
        const key = input.kind === 'favorite' ? 'favoriteUserIds' : 'subscriberUserIds'
        const ids = metadata[key]
        metadata[key] = ids.includes(user.id) ? ids.filter(id => id !== user.id) : [...ids, user.id]
        if (metadata[key].length > 200) return { error: 'issuePreferenceLimit' }
        const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, metadata), revision: latest.revision + 1 }).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).returning()
        await issueListChanged(tx, saved.id)
        return { issue: await issueView(saved, tx) }
      }))
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      return { error: 'generic' }
    }
  })
}

export async function getDeletedIssue(id: string) {
  try {
    const { issue, user } = await requireIssueAccess(id, true)
    await requireCurrentIssueWorkspace(user, issue.workspaceId)
    const deletedAt = readIssueMetadata(issue.content).deletedAt
    return issue.userId === user.id && deletedAt ? { id: issue.id, title: issue.title, deletedAt } : null
  } catch { return null }
}

export async function setIssueDeleted(input: { id: string; revision?: number; restore?: boolean }) {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive().optional(), restore: z.boolean().optional() }).safeParse(input)
    if (!parsed.success) return { error: 'issueOperationInvalid' }
    const { issue, user } = await requireIssueAccess(input.id, Boolean(input.restore))
    if (issue.userId !== user.id) return { error: 'issueOwnerOnly' }
    try {
      const result = await withIssueWorkspace(user, issue.workspaceId, () => db.transaction(async tx => {
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, user.id))).for('update')
        requireLockedIssueScope(latest, user.id, issue.scopeVersion, issue.workspaceId)
        if (!latest || (!input.restore && latest.revision !== input.revision)) return { error: 'issueOutdated' }
        const metadata = readIssueMetadata(latest.content)
        if (input.restore && metadata.deletedAt && Date.now() - new Date(metadata.deletedAt).getTime() > 30 * 86400000) return { error: 'issueRestoreWindow' }
        const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, { ...metadata, deletedAt: input.restore ? null : new Date().toISOString() }), revision: latest.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.userId, user.id))).returning()
        await issueListChanged(tx, saved.id, true)
        await issueRelationsChanged(tx, [saved.id])
        return { issue: await issueView(saved, tx) }
      }))
      if (input.restore && 'issue' in result && result.issue?.scope === 'workspace' && !result.issue.linearSyncBlocked && result.issue.linearTargetVerified) dispatchLinearIssueSync(issue.id)
      return result
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      return { error: 'issueDeleteFailed' }
    }
  })
}
