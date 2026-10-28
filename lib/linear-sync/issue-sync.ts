import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { z } from 'zod'
import { issueDocuments, issueMembers, issueVersions, issues, linearConnections, linearIssueDetachments, linearIssueLinks, linearIssuePublications, linearTeamSyncs, users } from '@/lib/db/schema'
import { issuePriorityForLinear, issueStatusForLinearType, labelColorForLinear, linearPriorityForIssue, linearStateForIssue } from './mapping'
import type { LinearStateOption } from './mapping'
import { linearMarkdownToIssueContent, issueContentToMarkdown } from './markdown'
import { createLinearIssue, ensureLinearLabel, findLinearUserByEmail, linearIssue, linearTeams, updateLinearIssue, type LinearIssueSnapshot } from './client'
import { hashValue } from './crypto'
import { linearAccessToken } from './tokens'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { allocateIssueNumbers } from '@/lib/issue-numbering'
import { issueDoneEvent } from '@/lib/coordinator-events'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { linearCommentSync } from './comment-sync'
import { encodedIssueDocument, loadIssueDocument, replaceIssueDescription } from './document'
import { linearDescriptionChanged, shouldApplyLinearSnapshot } from './sync-guards'
import { reserveLinearPublication, requireCurrentPublication, withCurrentPublication, withPublicationWriter, RetiredPublicationError, type Publication, type OutboxFence } from './publication'
import { systemActor } from '@/lib/activity-actor'

type IssueRow = typeof issues.$inferSelect
type TeamRow = typeof linearTeamSyncs.$inferSelect

export class LinearSyncConflictError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); this.name = 'LinearSyncConflictError' }
}

function externalLabelColor(color: string) {
  const colors: Record<string, string> = { violet: '#8b5cf6', blue: '#3b82f6', green: '#22c55e', yellow: '#eab308', red: '#ef4444', gray: '#6b7280' }
  return colors[color] ?? colors.gray!
}

async function localAssigneeForRemote(ownerId: string, issueId: string, remote: LinearIssueSnapshot, isNew: boolean) {
  if (!remote.assignee?.email) return null
  const [member] = await db.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.email, remote.assignee.email.toLowerCase())).limit(1)
  if (!member) return null
  if (member.id === ownerId) return { ...member, kind: 'member' as const }
  if (isNew) return null
  const [membership] = await db.select({ id: issueMembers.memberId }).from(issueMembers)
    .where(and(eq(issueMembers.issueId, issueId), eq(issueMembers.userId, ownerId), eq(issueMembers.memberId, member.id))).limit(1)
  return membership ? { ...member, kind: 'member' as const } : null
}

async function linearAssigneeId(ownerId: string, metadata: ReturnType<typeof readIssueMetadata>, token: string) {
  if (!metadata.assignee || metadata.assignee.kind !== 'member') return null
  const [member] = await db.select({ email: users.email }).from(users).where(eq(users.id, metadata.assignee.id)).limit(1)
  return member ? findLinearUserByEmail(token, member.email) : null
}

async function labelIdsForLocal(token: string, teamId: string, metadata: ReturnType<typeof readIssueMetadata>, beforeWrite: () => Promise<void>) {
  return Promise.all(metadata.labels.map(label => ensureLinearLabel(token, teamId, label.name, externalLabelColor(label.color), beforeWrite)))
}

async function syncLink(snapshot: Publication, identifier: string, linearUpdatedAt: string) {
  const { issue, team, publication } = snapshot
  return withCurrentPublication(snapshot, async tx => {
    const values = { publicationId: publication.id, teamSyncId: team.id, linearIssueId: publication.linearIssueId, linearIdentifier: identifier,
      linearDescriptionHash: hashValue(issueContentToMarkdown(issue.content)), syncStatus: 'synced', lastError: null,
      appSyncedAt: issue.updatedAt, linearUpdatedAt: new Date(linearUpdatedAt), updatedAt: new Date() }
    const [link] = await tx.insert(linearIssueLinks).values({ id: crypto.randomUUID(), issueId: issue.id, ownerId: issue.userId, ...values })
      .onConflictDoUpdate({ target: linearIssueLinks.issueId, set: values }).returning()
    await tx.update(linearIssuePublications).set({ writePending: false }).where(eq(linearIssuePublications.id, publication.id))
    return link
  })
}

async function buildLinearIssueInput(issue: IssueRow, team: TeamRow, token: string, states: LinearStateOption[], snapshot: Publication) {
  const metadata = readIssueMetadata(issue.content)
  const state = linearStateForIssue(issue.status as Parameters<typeof linearStateForIssue>[0], states)
  const assigneeId = await linearAssigneeId(issue.userId, metadata, token)
  return {
    id: snapshot.publication.linearIssueId,
    teamId: team.linearTeamId,
    title: issue.title,
    description: issueContentToMarkdown(issue.content),
    priority: linearPriorityForIssue(issue.priority as Parameters<typeof linearPriorityForIssue>[0]),
    dueDate: metadata.dueDate,
    ...(state ? { stateId: state.id } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    labelIds: await labelIdsForLocal(token, team.linearTeamId, metadata, () => requireCurrentPublication(snapshot)),
  }
}

export async function applyLinearIssueToApp(team: TeamRow, remote: LinearIssueSnapshot, force = false) {
  const [link] = await db.select({ link: linearIssueLinks, issue: issues, documentState: issueDocuments.state }).from(linearIssueLinks)
    .innerJoin(issues, eq(issues.id, linearIssueLinks.issueId))
    .leftJoin(issueDocuments, and(eq(issueDocuments.issueId, issues.id), eq(issueDocuments.userId, issues.userId)))
    .where(eq(linearIssueLinks.linearIssueId, remote.id)).limit(1)
  if (!link) return null
  if (link.link.teamSyncId !== team.id || !link.link.externalTargetVerified) return null
  if (!shouldApplyLinearSnapshot({ remoteUpdatedAt: new Date(remote.updatedAt), localUpdatedAt: link.issue.updatedAt, appSyncedAt: link.link.appSyncedAt, linearUpdatedAt: link.link.linearUpdatedAt, force })) return link.issue
  if (remote.title.length > 200) throw new LinearSyncConflictError('Linear issue title is longer than Mikka supports')

  const incomingContent = linearMarkdownToIssueContent(remote.description)
  if (JSON.stringify(incomingContent).length > 250_000) throw new LinearSyncConflictError('Linear description is larger than Mikka supports')
  if (remote.labels.length > 12) throw new LinearSyncConflictError('Linear issue has more than 12 labels; Mikka supports up to 12')
  const assignee = await localAssigneeForRemote(team.ownerId, link.issue.id, remote, false)
  const nextPriority = issuePriorityForLinear(remote.priority)
  let doneEvent = false
  const saved = await db.transaction(async tx => {
    await tx.execute(sql`select set_config('mikka.linear_sync_source', 'linear', true)`)
    const [latest] = await tx.select().from(issues).where(and(eq(issues.id, link.issue.id), eq(issues.userId, team.ownerId))).for('update')
    if (!latest || latest.scope !== 'workspace' || latest.linearSyncBlocked) return null
    const [currentLink] = await tx.select().from(linearIssueLinks).where(eq(linearIssueLinks.id, link.link.id)).for('update')
    if (!currentLink || !currentLink.externalTargetVerified || currentLink.ownerId !== team.ownerId || currentLink.teamSyncId !== team.id || currentLink.linearIssueId !== remote.id || !shouldApplyLinearSnapshot({ remoteUpdatedAt: new Date(remote.updatedAt), localUpdatedAt: latest.updatedAt, appSyncedAt: currentLink.appSyncedAt, linearUpdatedAt: currentLink.linearUpdatedAt, force })) return latest
    const latestMetadata = readIssueMetadata(latest.content)
    const nextStatus = issueStatusForLinearType(remote.state?.type ?? '', latest.status as Parameters<typeof issueStatusForLinearType>[1], remote.state?.name)
    const descriptionChanged = linearDescriptionChanged(remote.description, currentLink.linearDescriptionHash, issueContentToMarkdown(latest.content))
    const latestIncoming = withIssueMetadata(descriptionChanged ? incomingContent : latest.content, {
      ...latestMetadata,
      assignee,
      dueDate: remote.dueDate,
      labels: remote.labels.map(label => ({ name: label.name, color: labelColorForLinear(label.color) })),
    })
    const fieldsChanged = latest.title !== remote.title || latest.status !== nextStatus || latest.priority !== nextPriority || JSON.stringify(latestMetadata) !== JSON.stringify(readIssueMetadata(latestIncoming)) || descriptionChanged
    const nextRevision = latest.revision + (fieldsChanged ? 1 : 0)
    const [saved] = await tx.update(issues).set({
      title: remote.title, content: latestIncoming, status: nextStatus, priority: nextPriority,
      revision: nextRevision, updatedAt: new Date(),
    }).where(eq(issues.id, latest.id)).returning()
    const completionEvent = saved && issueDoneEvent(latest, saved)
    if (completionEvent) {
      await recordCoordinatorEvent(tx, completionEvent)
      doneEvent = true
    }

    if (descriptionChanged) {
      const [stored] = await tx.select({ state: issueDocuments.state }).from(issueDocuments).where(eq(issueDocuments.issueId, latest.id)).for('update').limit(1)
      const doc = loadIssueDocument(stored?.state ?? null, latest.content)
      try {
        replaceIssueDescription(doc, incomingContent)
        const state = encodedIssueDocument(doc)
        await tx.insert(issueDocuments).values({ issueId: latest.id, userId: latest.userId, state, updatedAt: new Date() })
          .onConflictDoUpdate({ target: issueDocuments.issueId, set: { state, updatedAt: new Date() } })
      } finally { doc.destroy() }
    }

    if (fieldsChanged) await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...systemActor('linear') })
    await tx.update(linearIssueLinks).set({ appSyncedAt: saved.updatedAt, linearUpdatedAt: new Date(remote.updatedAt), linearDescriptionHash: hashValue(remote.description ?? ''), syncStatus: 'synced', lastError: null, updatedAt: new Date() }).where(eq(linearIssueLinks.id, link.link.id))
    return saved
  })
  if (doneEvent && (process.env.VERCEL === '1' || process.env.AI_GATEWAY_API_KEY)) {
    const { wakeCoordinator } = await import('@/lib/coordinator/wake')
    await wakeCoordinator(team.ownerId)
  }
  return saved
}

export async function createAppIssueFromLinear(team: TeamRow, remote: LinearIssueSnapshot) {
  const linearId = z.uuid().safeParse(remote.id)
  if (!linearId.success) throw new LinearSyncConflictError('Linear returned an invalid issue ID')
  if (remote.title.length > 200) throw new LinearSyncConflictError('Linear issue title is longer than Mikka supports')
  if (remote.labels.length > 12) throw new LinearSyncConflictError('Linear issue has more than 12 labels; Mikka supports up to 12')
  const content = linearMarkdownToIssueContent(remote.description)
  if (JSON.stringify(content).length > 250_000) throw new LinearSyncConflictError('Linear description is larger than Mikka supports')
  const assignee = await localAssigneeForRemote(team.ownerId, remote.id, remote, true)
  const created = await db.transaction(async tx => {
    await tx.execute(sql`select set_config('mikka.linear_sync_source', 'linear', true)`)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${linearId.data}, 0))`)
    const [detached] = await tx.select({ id: linearIssueDetachments.linearIssueId }).from(linearIssueDetachments).where(eq(linearIssueDetachments.linearIssueId, remote.id)).limit(1)
    if (detached) return null
    const [publication] = await tx.select().from(linearIssuePublications).where(eq(linearIssuePublications.linearIssueId, remote.id)).limit(1)
    if (publication && (publication.retiredAt || publication.ownerId !== team.ownerId || publication.teamSyncId !== team.id)) return null
    const localId = publication?.issueId ?? linearId.data
    const [sameId] = await tx.select().from(issues).where(and(eq(issues.id, localId), eq(issues.userId, team.ownerId))).for('update').limit(1)
    if (sameId) {
      // Import never overrides a person's scope choice, including a detached UUID.
      if (sameId.scope !== 'workspace') return null
      const [existingLink] = await tx.select().from(linearIssueLinks).where(eq(linearIssueLinks.issueId, sameId.id)).limit(1)
      // A reserved create is still owned by the outgoing worker. Its webhook
      // must not acknowledge an old request against a newer local snapshot.
      if (publication && !existingLink) return { issue: sameId, syncRemote: false }
      if (existingLink && existingLink.linearIssueId !== remote.id) throw new LinearSyncConflictError('The issue is already linked to another Linear issue')
      const [remoteLink] = await tx.select().from(linearIssueLinks).where(eq(linearIssueLinks.linearIssueId, remote.id)).limit(1)
      if (remoteLink && remoteLink.issueId !== sameId.id) throw new LinearSyncConflictError('The Linear issue is already linked in Mikka')
      const syncRemote = existingLink
        ? !existingLink.linearUpdatedAt || remote.updatedAt > existingLink.linearUpdatedAt.toISOString()
        : remote.updatedAt > sameId.updatedAt.toISOString()
      if (!existingLink) await tx.insert(linearIssueLinks).values({
        id: crypto.randomUUID(), issueId: sameId.id, ownerId: team.ownerId, teamSyncId: team.id,
        linearIssueId: remote.id, linearIdentifier: remote.identifier, linearDescriptionHash: syncRemote ? null : hashValue(remote.description ?? ''), syncStatus: 'synced',
        appSyncedAt: sameId.updatedAt, linearUpdatedAt: syncRemote ? null : new Date(remote.updatedAt), updatedAt: new Date(),
      })
      return { issue: sameId, syncRemote }
    }
    const [collision] = await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, linearId.data)).limit(1)
    if (collision) throw new LinearSyncConflictError('Linear issue ID conflicts with an existing Mikka issue')
    const number = await allocateIssueNumbers(tx, team.ownerId)
    const metadata = {
      ...readIssueMetadata({ type: 'doc' }),
      number,
      assignee,
      dueDate: remote.dueDate,
      labels: remote.labels.slice(0, 12).map(label => ({ name: label.name, color: labelColorForLinear(label.color) })),
    }
    const id = linearId.data
    const issueContent = withIssueMetadata(content, metadata)
    const now = new Date()
    const [issue] = await tx.insert(issues).values({
      id, userId: team.ownerId, scope: 'workspace', title: remote.title, content: issueContent,
      status: issueStatusForLinearType(remote.state?.type ?? '', 'todo', remote.state?.name), priority: issuePriorityForLinear(remote.priority),
      revision: 1, createdAt: now, updatedAt: now,
    }).returning()
    const doc = loadIssueDocument(null, content)
    try {
      const state = encodedIssueDocument(doc)
      await tx.insert(issueDocuments).values({ issueId: id, userId: team.ownerId, state, updatedAt: now })
    } finally { doc.destroy() }
    await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: team.ownerId, revision: 1, title: issue.title, content: issue.content, status: issue.status, priority: issue.priority, ...systemActor('linear') })
    await tx.insert(linearIssueLinks).values({
      id: crypto.randomUUID(), issueId: id, ownerId: team.ownerId, teamSyncId: team.id,
      externalTargetVerified: true,
      linearIssueId: remote.id, linearIdentifier: remote.identifier, linearDescriptionHash: hashValue(remote.description ?? ''), syncStatus: 'synced',
      appSyncedAt: now, linearUpdatedAt: new Date(remote.updatedAt), updatedAt: now,
    })
    return { issue, syncRemote: false }
  })
  if (!created) return null
  if (created.syncRemote) return await applyLinearIssueToApp(team, remote) ?? created.issue
  return created.issue
}

export async function syncAppIssueToLinear(issueId: string, fence?: OutboxFence) {
  try {
    const reserved = await reserveLinearPublication(issueId, fence)
    if (!reserved) return null
    return await withPublicationWriter(reserved.publication.id, async () => {
      const snapshot = await reserveLinearPublication(issueId, fence, reserved.publication.scopeVersion)
      if (!snapshot || snapshot.publication.id !== reserved.publication.id) return null
      return syncPublication(snapshot)
    })
  } catch (error) { if (error instanceof RetiredPublicationError) return null; throw error }
}

async function syncPublication(snapshot: Publication) {
  const { issue, team, publication, link } = snapshot
  const metadata = readIssueMetadata(issue.content)
  const guard = () => requireCurrentPublication(snapshot)
  await guard()
  const [connection] = await db.select({ organizationId: linearConnections.organizationId }).from(linearConnections).where(eq(linearConnections.userId, issue.userId)).limit(1)
  if (!connection) throw new LinearSyncConflictError('Reconnect the Linear account to resume sync')
  const token = await linearAccessToken(issue.userId)
  const teams = await linearTeams(token)
  const externalTeam = teams.find(candidate => candidate.id === team.linearTeamId)
  if (!externalTeam) throw new LinearSyncConflictError('The connected Linear account can no longer access the mapped team')
  await guard()
  let remote: LinearIssueSnapshot | null = null
  if (link) {
    remote = await linearIssue(token, publication.linearIssueId)
    await guard()
    if (!remote) {
      await withCurrentPublication(snapshot, tx => tx.update(linearIssueLinks).set({ remoteRemovedAt: new Date(), syncStatus: 'remote_removed', lastError: null, updatedAt: new Date() }).where(eq(linearIssueLinks.id, link.id)))
      return { scopeVersion: issue.scopeVersion, observedUpdatedAt: issue.updatedAt }
    }
    if (remote.team.id !== team.linearTeamId) {
      await withCurrentPublication(snapshot, tx => tx.update(linearIssueLinks).set({ syncStatus: 'remote_team_changed', lastError: null, updatedAt: new Date() }).where(eq(linearIssueLinks.id, link.id)))
      return { scopeVersion: issue.scopeVersion, observedUpdatedAt: issue.updatedAt }
    }
    if (!publication.writePending && link.linearUpdatedAt && remote.updatedAt > link.linearUpdatedAt.toISOString() && remote.updatedAt > issue.updatedAt.toISOString()) {
      await applyLinearIssueToApp(team, remote, true)
      return { scopeVersion: issue.scopeVersion, observedUpdatedAt: issue.updatedAt }
    }
  }
  const input = await buildLinearIssueInput(issue, team, token, externalTeam.states, snapshot)
  let syncedLink: typeof linearIssueLinks.$inferSelect
  if (!link) {
    try {
      await guard()
      await withCurrentPublication(snapshot, tx => tx.update(linearIssuePublications).set({ writePending: true }).where(eq(linearIssuePublications.id, publication.id)))
      const created = await createLinearIssue(token, input)
      if (created.id !== publication.linearIssueId) throw new LinearSyncConflictError('Linear returned another publication identity')
      syncedLink = await syncLink(snapshot, created.identifier, created.updatedAt)
    } catch (error) {
      if (error instanceof RetiredPublicationError) throw error
      await guard()
      const existing = await linearIssue(token, publication.linearIssueId).catch(() => null)
      if (!existing || existing.team.id !== team.linearTeamId) throw error
      const { id: _id, teamId: _teamId, ...patch } = input
      await guard()
      const updatedAt = await updateLinearIssue(token, publication.linearIssueId, patch)
      syncedLink = await syncLink(snapshot, existing.identifier, updatedAt)
    }
  } else {
    const remoteLabelNames = remote!.labels.map(label => label.name.toLowerCase()).sort()
    const localLabelNames = metadata.labels.map(label => label.name.toLowerCase()).sort()
    const nextState = linearStateForIssue(issue.status as Parameters<typeof linearStateForIssue>[0], externalTeam.states)
    const assigneeId = await linearAssigneeId(issue.userId, metadata, token)
    const patch: Record<string, unknown> = {}
    if (remote!.title !== input.title) patch.title = input.title
    if ((remote!.description ?? '') !== input.description) patch.description = input.description
    if (remote!.priority !== input.priority) patch.priority = input.priority
    if (remote!.dueDate !== input.dueDate) patch.dueDate = input.dueDate
    if ((remote!.assignee?.id ?? null) !== assigneeId) patch.assigneeId = assigneeId
    if (JSON.stringify(remoteLabelNames) !== JSON.stringify(localLabelNames)) patch.labelIds = input.labelIds
    if (nextState && remote!.state?.id !== nextState.id) patch.stateId = nextState.id
    await guard()
    await withCurrentPublication(snapshot, tx => tx.update(linearIssuePublications).set({ writePending: true }).where(eq(linearIssuePublications.id, publication.id)))
    const updatedAt = Object.keys(patch).length ? await updateLinearIssue(token, publication.linearIssueId, patch as Parameters<typeof updateLinearIssue>[2]) : remote!.updatedAt
    syncedLink = await syncLink(snapshot, link.linearIdentifier, updatedAt)
  }
  // Keep this exact generation's mapping. Looking up a fresh link by local ID
  // here would let a delayed old write upload comments into a new publication.
  await guard()
  await linearCommentSync(issue, syncedLink, snapshot.documentState, token, connection.organizationId, snapshot)
  return { scopeVersion: issue.scopeVersion, observedUpdatedAt: issue.updatedAt }
}
