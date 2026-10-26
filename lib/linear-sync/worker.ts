import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { pool, db } from '@/lib/db'
import { issues, linearCommentLinks, linearConnections, linearIssueDetachments, linearIssueLinks, linearSyncInbox, linearSyncOutbox, linearTeamSyncs } from '@/lib/db/schema'
import { LinearApiError, sanitizeLinearError } from './graphql'
import { applyLinearCommentToApp } from './comment-sync'
import { createAppIssueFromLinear, applyLinearIssueToApp, LinearSyncConflictError, syncAppIssueToLinear } from './issue-sync'
import { linearAccessToken } from './tokens'
import { linearComment, linearIssue } from './client'

type InboxRow = typeof linearSyncInbox.$inferSelect
type OutboxJob = { id: string; issueId: string; attempts: number }
type WebhookEvent = {
  action?: string
  type?: string
  organizationId?: string
  createdAt?: string
  webhookTimestamp?: number
  data?: Record<string, unknown>
}

function errorText(error: unknown) {
  return sanitizeLinearError(error instanceof Error ? error.message : 'Linear sync failed')
}

function retryDelay(attempts: number) {
  return Math.min(60 * 60, 30 * 2 ** Math.min(attempts, 7))
}

async function claimOutbox(issueId?: string): Promise<OutboxJob | null> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const predicate = issueId ? `and "issueId" = $1` : ''
    const { rows } = await client.query<OutboxJob>(`select id, "issueId", attempts from linear_sync_outbox
      where ((status = 'queued' and "availableAt" <= now()) or (status = 'processing' and "lastAttemptAt" < now() - interval '5 minutes')) ${predicate}
      order by "availableAt", "createdAt" for update skip locked limit 1`, issueId ? [issueId] : [])
    const job = rows[0]
    if (!job) { await client.query('commit'); return null }
    await client.query(`update linear_sync_outbox set status = 'processing', attempts = attempts + 1,
      "lastAttemptAt" = now(), "updatedAt" = now() where id = $1`, [job.id])
    await client.query('commit')
    return { ...job, attempts: job.attempts + 1 }
  } catch (error) { await client.query('rollback'); throw error }
  finally { client.release() }
}

async function finishOutbox(job: OutboxJob, observedUpdatedAt: Date | null) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const { rows } = await client.query<{ updatedAt: Date | null }>(`select i."updatedAt" from issues i where i.id = $1 for update`, [job.issueId])
    const changed = Boolean(rows[0]?.updatedAt && observedUpdatedAt && rows[0].updatedAt.getTime() > observedUpdatedAt.getTime())
    await client.query(`update linear_sync_outbox set status = $2, attempts = case when $2 = 'queued' then 0 else attempts end,
      "availableAt" = now(), "lastError" = null, "updatedAt" = now() where id = $1`, [job.id, changed ? 'queued' : 'done'])
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error }
  finally { client.release() }
}

async function failOutbox(job: OutboxJob, issueId: string, error: unknown) {
  const permanent = error instanceof LinearApiError ? !error.retryable : error instanceof LinearSyncConflictError ? !error.retryable : true
  const status = permanent || job.attempts >= 8 ? 'failed' : 'queued'
  const message = errorText(error)
  await db.update(linearSyncOutbox).set({ status, availableAt: new Date(Date.now() + retryDelay(job.attempts) * 1000), lastError: message, updatedAt: new Date() }).where(eq(linearSyncOutbox.id, job.id))
  await db.update(linearIssueLinks).set({ syncStatus: 'error', lastError: message, updatedAt: new Date() }).where(eq(linearIssueLinks.issueId, issueId))
  const [issue] = await db.select({ ownerId: issues.userId }).from(issues).where(eq(issues.id, issueId)).limit(1)
  if (issue) await db.update(linearTeamSyncs).set({ lastError: message, lastErrorAt: new Date(), updatedAt: new Date() }).where(and(eq(linearTeamSyncs.ownerId, issue.ownerId), eq(linearTeamSyncs.active, true)))
}

async function processOutboxOne(issueId?: string) {
  const job = await claimOutbox(issueId)
  if (!job) return false
  const [issue] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, job.issueId)).limit(1)
  if (!issue) {
    await db.update(linearSyncOutbox).set({ status: 'done', updatedAt: new Date() }).where(eq(linearSyncOutbox.id, job.id))
    return true
  }
  try {
    await syncAppIssueToLinear(job.issueId)
    await finishOutbox(job, issue.updatedAt)
    const [latestIssue] = await db.select({ ownerId: issues.userId }).from(issues).where(eq(issues.id, job.issueId)).limit(1)
    if (latestIssue) await db.update(linearTeamSyncs).set({ lastError: null, lastErrorAt: null, updatedAt: new Date() }).where(and(eq(linearTeamSyncs.ownerId, latestIssue.ownerId), eq(linearTeamSyncs.active, true)))
  } catch (error) {
    await failOutbox(job, job.issueId, error)
  }
  return true
}

function stringField(object: Record<string, unknown> | undefined, key: string) {
  return typeof object?.[key] === 'string' ? object[key] as string : null
}

async function teamForEvent(organizationId: string | undefined, teamId: string | null) {
  if (!organizationId || !teamId) return null
  const [row] = await db.select({ team: linearTeamSyncs, organizationId: linearConnections.organizationId }).from(linearTeamSyncs)
    .innerJoin(linearConnections, eq(linearConnections.userId, linearTeamSyncs.ownerId))
    .where(and(eq(linearTeamSyncs.linearTeamId, teamId), eq(linearTeamSyncs.active, true), eq(linearConnections.organizationId, organizationId))).limit(1)
  return row?.team ?? null
}

async function processIssueEvent(event: WebhookEvent) {
  const data = event.data
  const remoteId = stringField(data, 'id')
  if (!remoteId) return
  const [detached] = await db.select({ id: linearIssueDetachments.linearIssueId }).from(linearIssueDetachments).where(eq(linearIssueDetachments.linearIssueId, remoteId)).limit(1)
  if (detached) return
  const [link] = await db.select().from(linearIssueLinks).where(eq(linearIssueLinks.linearIssueId, remoteId)).limit(1)
  if (event.action === 'remove') {
    if (link && event.organizationId) {
      const [owner] = await db.select({ id: linearIssueLinks.id }).from(linearIssueLinks)
        .innerJoin(linearTeamSyncs, eq(linearTeamSyncs.id, linearIssueLinks.teamSyncId))
        .innerJoin(linearConnections, eq(linearConnections.userId, linearTeamSyncs.ownerId))
        .where(and(eq(linearIssueLinks.id, link.id), eq(linearConnections.organizationId, event.organizationId))).limit(1)
      if (owner) await db.update(linearIssueLinks).set({ remoteRemovedAt: new Date(), syncStatus: 'remote_removed', lastError: null, updatedAt: new Date() }).where(eq(linearIssueLinks.id, link.id))
    }
    return
  }
  const teamData = data?.team as Record<string, unknown> | undefined
  const teamId = stringField(teamData, 'id') ?? stringField(data, 'teamId')
  const team = await teamForEvent(event.organizationId, teamId)
  if (!team) return
  const token = await linearAccessToken(team.ownerId)
  const remote = await linearIssue(token, remoteId)
  if (!remote || remote.team.id !== team.linearTeamId) return

  if (link) await applyLinearIssueToApp(team, remote)
  else await createAppIssueFromLinear(team, remote)
  await db.update(linearTeamSyncs).set({ lastError: null, lastErrorAt: null, updatedAt: new Date() }).where(eq(linearTeamSyncs.id, team.id))
}

async function issueLinkForComment(event: WebhookEvent, comment: Record<string, unknown>) {
  const remoteIssueId = stringField(comment, 'issueId') ?? stringField(comment.issue as Record<string, unknown> | undefined, 'id')
  if (!remoteIssueId) return null
  const [existing] = await db.select({ link: linearIssueLinks, team: linearTeamSyncs, connection: linearConnections })
    .from(linearIssueLinks).innerJoin(linearTeamSyncs, eq(linearTeamSyncs.id, linearIssueLinks.teamSyncId))
    .innerJoin(linearConnections, eq(linearConnections.userId, linearTeamSyncs.ownerId))
    .where(and(eq(linearIssueLinks.linearIssueId, remoteIssueId), eq(linearTeamSyncs.active, true))).limit(1)
  if (existing && (!event.organizationId || existing.connection.organizationId === event.organizationId)) return { ...existing, remoteIssueId }

  const externalIssue = comment.issue as Record<string, unknown> | undefined
  const externalTeam = externalIssue?.team as Record<string, unknown> | undefined
  const teamId = stringField(externalTeam, 'id') ?? stringField(externalIssue, 'teamId')
  const team = await teamForEvent(event.organizationId, teamId)
  if (!team) return null
  const token = await linearAccessToken(team.ownerId)
  const remote = await linearIssue(token, remoteIssueId)
  if (!remote) return null
  await createAppIssueFromLinear(team, remote)
  const [link] = await db.select().from(linearIssueLinks).where(eq(linearIssueLinks.linearIssueId, remoteIssueId)).limit(1)
  return link ? { link, team, connection: { organizationId: event.organizationId }, remoteIssueId } : null
}

async function processCommentEvent(event: WebhookEvent) {
  const data = event.data
  if (!data) return
  const commentId = stringField(data, 'id')
  if (!commentId) return
  const remoteIssueId = stringField(data, 'issueId') ?? stringField(data.issue as Record<string, unknown> | undefined, 'id')
  if (remoteIssueId) {
    const [detached] = await db.select({ id: linearIssueDetachments.linearIssueId }).from(linearIssueDetachments).where(eq(linearIssueDetachments.linearIssueId, remoteIssueId)).limit(1)
    if (detached) return
  }
  const [existingComment] = await db.select().from(linearCommentLinks).where(eq(linearCommentLinks.linearCommentId, commentId)).limit(1)
  if (event.action === 'remove') {
    if (existingComment && event.organizationId) {
      const [owner] = await db.select({ id: linearCommentLinks.id }).from(linearCommentLinks)
        .innerJoin(linearIssueLinks, eq(linearIssueLinks.id, linearCommentLinks.issueLinkId))
        .innerJoin(linearTeamSyncs, eq(linearTeamSyncs.id, linearIssueLinks.teamSyncId))
        .innerJoin(linearConnections, eq(linearConnections.userId, linearTeamSyncs.ownerId))
        .where(and(eq(linearCommentLinks.id, existingComment.id), eq(linearConnections.organizationId, event.organizationId))).limit(1)
      if (owner) await db.update(linearCommentLinks).set({ syncStatus: 'remote_removed', updatedAt: new Date() }).where(eq(linearCommentLinks.id, existingComment.id))
    }
    return
  }
  const resolved = await issueLinkForComment(event, data)
  if (!resolved) throw new LinearSyncConflictError('Waiting for the related Linear issue to be linked', true)
  const token = await linearAccessToken(resolved.team.ownerId)
  const remote = await linearComment(token, commentId)
  if (!remote || remote.issue?.id !== resolved.remoteIssueId) return
  const [issue] = await db.select().from(issues).where(eq(issues.id, resolved.link.issueId)).limit(1)
  if (!issue) return
  await importLinearCommentChain(token, issue, resolved.link, remote)
  await db.update(linearTeamSyncs).set({ lastError: null, lastErrorAt: null, updatedAt: new Date() }).where(eq(linearTeamSyncs.id, resolved.team.id))
}

async function importLinearCommentChain(token: string, issue: typeof issues.$inferSelect, issueLink: typeof linearIssueLinks.$inferSelect, comment: NonNullable<Awaited<ReturnType<typeof linearComment>>>) {
  if (comment.parent) {
    const [parentLink] = await db.select({ id: linearCommentLinks.id, issueLinkId: linearCommentLinks.issueLinkId }).from(linearCommentLinks).where(eq(linearCommentLinks.linearCommentId, comment.parent.id)).limit(1)
    if (parentLink && parentLink.issueLinkId !== issueLink.id) throw new LinearSyncConflictError('Linear reply parent belongs to another issue')
    if (!parentLink) {
      const parent = await linearComment(token, comment.parent.id)
      if (!parent || parent.issue?.id !== issueLink.linearIssueId) throw new LinearSyncConflictError('Waiting for the parent Linear comment to sync', true)
      await importLinearCommentChain(token, issue, issueLink, parent)
    }
  }
  await applyLinearCommentToApp({
    issue,
    issueLink,
    id: comment.id,
    body: comment.body,
    author: comment.user?.name ?? 'Linear user',
    parentId: comment.parent?.id ?? null,
    createdAt: comment.createdAt,
    action: 'update',
  })
}

async function processWebhook(event: WebhookEvent) {
  if (event.type === 'Issue') return processIssueEvent(event)
  if (event.type === 'Comment') return processCommentEvent(event)
  if (event.type === 'OAuthAuthorization') {
    const linearUserId = stringField(event.data, 'userId')
    if (event.organizationId && linearUserId && ['remove', 'revoke', 'revoked'].includes(event.action ?? '')) {
      const [owner] = await db.select({ userId: linearConnections.userId }).from(linearConnections)
        .where(and(eq(linearConnections.organizationId, event.organizationId), eq(linearConnections.linearUserId, linearUserId))).limit(1)
      if (owner) {
        await db.update(linearConnections).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(linearConnections.userId, owner.userId))
        await db.update(linearTeamSyncs).set({ active: false, updatedAt: new Date() }).where(and(eq(linearTeamSyncs.ownerId, owner.userId), eq(linearTeamSyncs.active, true)))
      }
    }
  }
  if (event.type === 'OAuthApp') {
    if (['remove', 'revoke', 'revoked'].includes(event.action ?? '')) {
      if (event.organizationId) {
        const owners = await db.select({ userId: linearConnections.userId }).from(linearConnections).where(eq(linearConnections.organizationId, event.organizationId))
        await db.update(linearConnections).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(linearConnections.organizationId, event.organizationId))
        if (owners.length) await db.update(linearTeamSyncs).set({ active: false, updatedAt: new Date() }).where(and(inArray(linearTeamSyncs.ownerId, owners.map(owner => owner.userId)), eq(linearTeamSyncs.active, true)))
      }
    }
  }
}

async function claimInbox(deliveryId?: string): Promise<InboxRow | null> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const predicate = deliveryId ? 'and "deliveryId" = $1' : ''
    const { rows } = await client.query<InboxRow>(`select * from linear_sync_inbox
      where ((status = 'queued' and "availableAt" <= now()) or (status = 'processing' and "lastAttemptAt" < now() - interval '5 minutes')) ${predicate}
      order by "availableAt", "receivedAt" for update skip locked limit 1`, deliveryId ? [deliveryId] : [])
    const row = rows[0]
    if (!row) { await client.query('commit'); return null }
    await client.query(`update linear_sync_inbox set status = 'processing', attempts = attempts + 1,
      "lastAttemptAt" = now() where "deliveryId" = $1`, [row.deliveryId])
    await client.query('commit')
    return { ...row, attempts: row.attempts + 1, status: 'processing' }
  } catch (error) { await client.query('rollback'); throw error }
  finally { client.release() }
}

async function processInboxOne(deliveryId?: string) {
  const row = await claimInbox(deliveryId)
  if (!row) return false
  try {
    await processWebhook(row.payload as WebhookEvent)
    await db.update(linearSyncInbox).set({ status: 'done', lastError: null, processedAt: new Date() }).where(eq(linearSyncInbox.deliveryId, row.deliveryId))
  } catch (error) {
    const permanent = error instanceof LinearApiError ? !error.retryable : error instanceof LinearSyncConflictError ? !error.retryable : true
    const status = permanent || row.attempts >= 8 ? 'failed' : 'queued'
    const message = errorText(error)
    await db.update(linearSyncInbox).set({ status, lastError: message, availableAt: new Date(Date.now() + retryDelay(row.attempts) * 1000) }).where(eq(linearSyncInbox.deliveryId, row.deliveryId))
    const payload = row.payload as WebhookEvent
    const data = payload.data
    const team = await teamForEvent(payload.organizationId, stringField(data?.team as Record<string, unknown> | undefined, 'id') ?? stringField(data, 'teamId') ?? stringField((data?.issue as Record<string, unknown> | undefined)?.team as Record<string, unknown> | undefined, 'id'))
    if (team) await db.update(linearTeamSyncs).set({ lastError: message, lastErrorAt: new Date(), updatedAt: new Date() }).where(eq(linearTeamSyncs.id, team.id))
  }
  return true
}

export async function processLinearSyncBatch(limit = 3) {
  let inbox = 0
  let outbox = 0
  for (let index = 0; index < limit; index++) {
    if (!(await processInboxOne())) break
    inbox++
  }
  for (let index = 0; index < limit; index++) {
    if (!(await processOutboxOne())) break
    outbox++
  }
  return { inbox, outbox }
}

export async function processLinearIssueOutbox(issueId: string) {
  await processOutboxOne(issueId)
}

export async function processLinearInboxDelivery(deliveryId: string) {
  await processInboxOne(deliveryId)
}
