'use server'

import { and, desc, eq, sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import { db } from '@/lib/db'
import { issues, issueMembers, issueVersions } from '@/lib/db/schema'
import { requireIssueAccess } from '@/lib/issue-access'
import { issueVisibility } from '@/lib/issue-visibility'
import { issueView, taskIdentifiers } from '@/lib/task-identifier-server'
import { readIssueMetadata, withIssueMetadata, type IssueMetadata } from '@/lib/issue-metadata'
import { allocateIssueNumbers } from '@/lib/issue-numbering'
import { createsIssueCycle } from '@/lib/issue-relations'
import { dispatchLinearIssueSync, dispatchLinearWork } from '@/lib/linear-sync/dispatch'
import { activityActor } from '@/lib/activity-actor'
import { requireLockedIssueScope } from '@/lib/issue-scope-authorization'

const relationSchema = z.object({ id: z.uuid(), revision: z.number().int().positive(), targetId: z.uuid().nullable(), kind: z.enum(['parent', 'child', 'related', 'blockedBy', 'blocks', 'duplicate']), remove: z.boolean().default(false) })

/**
 * Runs after the write has committed. Scheduling Linear sync can throw (e.g. `after` outside a
 * request); that must not turn a saved change into a "save failed" response, so it only logs.
 */
function scheduleLinearWork() {
  try { dispatchLinearWork() }
  catch (error) { console.error('Linear background sync could not be scheduled', error instanceof Error ? error.name : 'UnknownError') }
}

export async function listIssueConnections(id: string) {
  const { issue, user } = await requireIssueAccess(id)
  return db.transaction(async tx => {
  const [locked] = await tx.select().from(issues).where(eq(issues.id, id)).for('share')
  requireLockedIssueScope(locked, user.id, issue.scopeVersion)
  const rows = await tx.select({ id: issues.id, ownerId: issues.userId, title: issues.title, status: issues.status, priority: issues.priority, scope: issues.scope, scopeVersion: issues.scopeVersion, revision: issues.revision, content: issues.content, createdAt: issues.createdAt }).from(issues)
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, user.id)))
    .where(and(eq(issues.userId, issue.userId), (await issueVisibility(user.id)).predicate)).orderBy(desc(issues.updatedAt))
  const live = rows.filter(row => !readIssueMetadata(row.content).deletedAt)
  const identifiers = await taskIdentifiers(live.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: readIssueMetadata(row.content).number })))
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
    if (target && target.userId !== issue.userId) return { error: 'issueCrossOwner' }
    if (!target && value.kind !== 'parent') return { error: 'issueTargetRequired' }
    try {
      const result = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${issue.userId}, 0))`)
        const rows = await tx.select().from(issues).where(eq(issues.userId, issue.userId)).orderBy(issues.id).for('update')
        const current = rows.find(row => row.id === issue.id)
        const other = rows.find(row => row.id === target?.id)
        requireLockedIssueScope(current, user.id, issue.scopeVersion)
        if (target) requireLockedIssueScope(other, user.id, target.scopeVersion)
        if (!current || current.revision !== value.revision || readIssueMetadata(current.content).deletedAt) return { error: 'issueOutdated' }
        if (target && (!other || readIssueMetadata(other.content).deletedAt)) return { error: 'issueTargetUnavailable' }
        if (user.id !== issue.userId) {
          const memberships = await tx.select({ id: issueMembers.issueId }).from(issueMembers).where(and(eq(issueMembers.userId, issue.userId), eq(issueMembers.memberId, user.id)))
          if (![current.id, ...(other ? [other.id] : [])].every(id => memberships.some(member => member.id === id))) return { error: 'issueAccessChanged' }
        }
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
          const graph = new Map(rows.map(row => [row.id, readIssueMetadata(row.content).parentId ? [readIssueMetadata(row.content).parentId!] : []]))
          if (parentId && createsIssueCycle(child.id, [parentId], graph)) return { error: 'issueParentCycle' }
          update(child.id, { parentId })
        } else if (value.kind === 'related') {
          update(current.id, { relatedIds: toggle(metadata.relatedIds, other!.id) })
          update(other!.id, { relatedIds: toggle(targetMetadata!.relatedIds, current.id) })
        } else if (value.kind === 'duplicate') {
          if (!value.remove && createsIssueCycle(current.id, [other!.id], new Map(rows.map(row => [row.id, readIssueMetadata(row.content).duplicateOfId ? [readIssueMetadata(row.content).duplicateOfId!] : []])))) return { error: 'issueDuplicateCycle' }
          update(current.id, { duplicateOfId: value.remove ? null : other!.id }, value.remove ? 'todo' : 'duplicate')
        } else {
          const blocked = value.kind === 'blocks' ? other! : current
          const blocker = value.kind === 'blocks' ? current : other!
          const blockedMetadata = readIssueMetadata(blocked.content)
          const next = toggle(blockedMetadata.blockedByIds, blocker.id)
          const graph = new Map(rows.map(row => [row.id, readIssueMetadata(row.content).blockedByIds]))
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
          if (id === current.id) savedCurrent = saved
        }
        return { issue: await issueView(savedCurrent, tx) }
      })
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
    const { issue, user } = await requireIssueAccess(input.id)
    const accessible = input.includeSubissues ? await listIssueConnections(issue.id) : []
    try {
      const result = await db.transaction(async tx => {
        for (const owner of [...new Set([issue.userId, user.id])].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`)
        const [source] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
        requireLockedIssueScope(source, user.id, issue.scopeVersion)
        if (!source || source.revision !== input.revision || readIssueMetadata(source.content).deletedAt) return { error: 'issueOutdated' }
        const metadata = readIssueMetadata(source.content)
        const child = input.kind === 'child'
        if (child && !parsed.data.title) return { error: 'issueChildTitleRequired' }
        const ownerId = child ? source.userId : user.id
        if (user.id !== source.userId) {
          const [membership] = await tx.select({ id: issueMembers.memberId }).from(issueMembers).where(and(eq(issueMembers.issueId, source.id), eq(issueMembers.userId, source.userId), eq(issueMembers.memberId, user.id)))
          if (!membership) return { error: 'issueAccessChanged' }
        }
        const number = await allocateIssueNumbers(tx, ownerId)
        const newMetadata = { ...metadata, number, parentId: child ? source.id : null, blockedByIds: [], relatedIds: [], duplicateOfId: null, favoriteUserIds: [], subscriberUserIds: [], deletedAt: null, assignee: child || source.userId === user.id ? metadata.assignee : null }
        const [created] = await tx.insert(issues).values({ id: crypto.randomUUID(), userId: ownerId, title: parsed.data.title ?? t('defaultDuplicateTitle', { title: source.title.slice(0, 195) }), content: withIssueMetadata(child ? { type: 'doc', content: [{ type: 'paragraph' }] } : source.content, newMetadata), status: 'todo', priority: source.priority, revision: 1 }).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: created.id, userId: ownerId, revision: 1, title: created.title, content: created.content, status: created.status, priority: created.priority, ...activityActor(user.id) })
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
              if (!original || (original.userId !== user.id && (original.scope !== 'workspace' || original.scopeVersion !== item.scopeVersion))) continue
              const currentMetadata = readIssueMetadata(original.content)
              if (currentMetadata.deletedAt || currentMetadata.parentId !== parentId) continue
              const id = crypto.randomUUID()
              const copyMetadata = { ...currentMetadata, number: await allocateIssueNumbers(tx, ownerId), parentId: mapping.get(parentId)!, blockedByIds: [], relatedIds: [], duplicateOfId: null, favoriteUserIds: [], subscriberUserIds: [], deletedAt: null, assignee: source.userId === user.id ? currentMetadata.assignee : null }
              const [copy] = await tx.insert(issues).values({ id, userId: ownerId, title: original.title, content: withIssueMetadata(original.content, copyMetadata), status: 'todo', priority: original.priority, revision: 1 }).returning()
              await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: ownerId, revision: 1, title: copy.title, content: copy.content, status: copy.status, priority: copy.priority, ...activityActor(user.id) })
              mapping.set(item.id, id); queue.push(item.id)
            }
          }
        }
        return { issue: await issueView(created, tx) }
      })
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
      return await db.transaction(async tx => {
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
        requireLockedIssueScope(latest, user.id, issue.scopeVersion)
        if (!latest || readIssueMetadata(latest.content).deletedAt) return { error: 'issueUnavailable' }
        const metadata = readIssueMetadata(latest.content)
        const key = input.kind === 'favorite' ? 'favoriteUserIds' : 'subscriberUserIds'
        const ids = metadata[key]
        metadata[key] = ids.includes(user.id) ? ids.filter(id => id !== user.id) : [...ids, user.id]
        if (metadata[key].length > 200) return { error: 'issuePreferenceLimit' }
        const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, metadata), revision: latest.revision + 1 }).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).returning()
        return { issue: await issueView(saved, tx) }
      })
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      return { error: 'generic' }
    }
  })
}

export async function getDeletedIssue(id: string) {
  try {
    const { issue, user } = await requireIssueAccess(id, true)
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
      const result = await db.transaction(async tx => {
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, user.id))).for('update')
        if (!latest || (!input.restore && latest.revision !== input.revision)) return { error: 'issueOutdated' }
        const metadata = readIssueMetadata(latest.content)
        if (input.restore && metadata.deletedAt && Date.now() - new Date(metadata.deletedAt).getTime() > 30 * 86400000) return { error: 'issueRestoreWindow' }
        const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, { ...metadata, deletedAt: input.restore ? null : new Date().toISOString() }), revision: latest.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.userId, user.id))).returning()
        return { issue: await issueView(saved, tx) }
      })
      if (input.restore && 'issue' in result && result.issue?.scope === 'workspace' && !result.issue.linearSyncBlocked && result.issue.linearTargetVerified) dispatchLinearIssueSync(issue.id)
      return result
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      return { error: 'issueDeleteFailed' }
    }
  })
}
