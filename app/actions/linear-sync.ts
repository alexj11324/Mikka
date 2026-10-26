'use server'

import { cookies } from 'next/headers'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireUser, requireIssueAccess } from '@/lib/issue-access'
import { db } from '@/lib/db'
import { issues, linearConnections, linearIssueLinks, linearSyncInbox, linearSyncOutbox, linearTeamSyncs } from '@/lib/db/schema'
import { createLinearAuthorizationUrl, disconnectLinear, LINEAR_OAUTH_CALLBACK_PATH, LINEAR_OAUTH_STATE_COOKIE, linearAccessToken, linearOAuthConfigured } from '@/lib/linear-sync/oauth'
import { linearTeams } from '@/lib/linear-sync/client'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { dispatchLinearIssueSync, dispatchLinearWebhook } from '@/lib/linear-sync/dispatch'

export async function getLinearIntegrationState() {
  const user = await requireUser()
  const [connection] = await db.select({ organizationName: linearConnections.organizationName, connected: linearConnections.userId })
    .from(linearConnections).where(and(eq(linearConnections.userId, user.id), isNull(linearConnections.revokedAt))).limit(1)
  const syncs = await db.select({ id: linearTeamSyncs.id, linearTeamId: linearTeamSyncs.linearTeamId, linearTeamKey: linearTeamSyncs.linearTeamKey, linearTeamName: linearTeamSyncs.linearTeamName, active: linearTeamSyncs.active, lastError: linearTeamSyncs.lastError })
    .from(linearTeamSyncs).where(eq(linearTeamSyncs.ownerId, user.id)).orderBy(desc(linearTeamSyncs.createdAt))
  const errors = await db.select({ id: linearSyncOutbox.id, issueId: issues.id, title: issues.title, identifier: linearIssueLinks.linearIdentifier, message: linearSyncOutbox.lastError, updatedAt: linearSyncOutbox.updatedAt })
    .from(linearSyncOutbox).innerJoin(issues, eq(issues.id, linearSyncOutbox.issueId))
    .leftJoin(linearIssueLinks, eq(linearIssueLinks.issueId, issues.id))
    .where(and(eq(issues.userId, user.id), eq(linearSyncOutbox.status, 'failed')))
    .orderBy(desc(linearSyncOutbox.updatedAt)).limit(20)
  const inboundErrors = await db.select({ id: linearSyncInbox.deliveryId, eventType: linearSyncInbox.eventType, message: linearSyncInbox.lastError, receivedAt: linearSyncInbox.receivedAt })
    .from(linearSyncInbox).innerJoin(linearConnections, and(eq(linearConnections.organizationId, linearSyncInbox.organizationId), eq(linearConnections.userId, user.id)))
    .where(and(eq(linearSyncInbox.status, 'failed'), isNull(linearConnections.revokedAt)))
    .orderBy(desc(linearSyncInbox.receivedAt)).limit(20)
  return { configured: linearOAuthConfigured(), connected: Boolean(connection), organizationName: connection?.organizationName ?? null, syncs, errors, inboundErrors }
}

export async function startLinearOAuth() {
  const user = await requireUser()
  const authorization = await createLinearAuthorizationUrl(user.id)
  ;(await cookies()).set(LINEAR_OAUTH_STATE_COOKIE, authorization.state, { httpOnly: true, sameSite: 'lax', secure: true, path: LINEAR_OAUTH_CALLBACK_PATH, maxAge: 600 })
  return { url: authorization.url }
}

export async function listLinearTeamOptions() {
  const user = await requireUser()
  const token = await linearAccessToken(user.id)
  return (await linearTeams(token)).map(({ id, key, name }) => ({ id, key, name }))
}

export async function enableLinearTeam(input: { teamId: string }) {
  const user = await requireUser()
  const parsed = z.object({ teamId: z.string().uuid() }).safeParse(input)
  if (!parsed.success) return { error: 'linearTeamInvalid' as const }
  const token = await linearAccessToken(user.id)
  const team = (await linearTeams(token)).find(option => option.id === parsed.data.teamId)
  if (!team) return { error: 'linearTeamUnavailable' as const }
  const [existing] = await db.select().from(linearTeamSyncs).where(eq(linearTeamSyncs.linearTeamId, team.id)).limit(1)
  if (existing && existing.ownerId !== user.id) return { error: 'linearTeamAlreadyLinked' as const }
  const now = new Date()
  await db.transaction(async tx => {
    await tx.update(linearTeamSyncs).set({ active: false, updatedAt: now }).where(eq(linearTeamSyncs.ownerId, user.id))
    if (existing) await tx.update(linearTeamSyncs).set({ linearTeamKey: team.key, linearTeamName: team.name, active: true, lastError: null, lastErrorAt: null, updatedAt: now }).where(eq(linearTeamSyncs.id, existing.id))
    else await tx.insert(linearTeamSyncs).values({ id: crypto.randomUUID(), ownerId: user.id, linearTeamId: team.id, linearTeamKey: team.key, linearTeamName: team.name, active: true, updatedAt: now })
  })
  return { success: true as const }
}

export async function disableLinearTeam(id: string) {
  const user = await requireUser()
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) return { error: 'linearTeamInvalid' as const }
  await db.update(linearTeamSyncs).set({ active: false, updatedAt: new Date() }).where(and(eq(linearTeamSyncs.id, parsed.data), eq(linearTeamSyncs.ownerId, user.id)))
  return { success: true as const }
}

export async function retryLinearIssue(issueId: string) {
  const user = await requireUser()
  const parsed = z.uuid().safeParse(issueId)
  if (!parsed.success) return { error: 'linearIssueInvalid' as const }
  const { issue } = await requireIssueAccess(parsed.data)
  if (issue.userId !== user.id) return { error: 'issueOwnerOnly' as const }
  const result = await db.transaction(async tx => {
    // Match scope/publication writers: task first, then outbox. The access
    // snapshot above may predate retirement or another publication generation.
    const [latest] = await tx.select().from(issues).where(eq(issues.id, issue.id)).for('update')
    if (!latest || latest.userId !== user.id) return { error: 'issueOwnerOnly' as const }
    if (latest.linearSyncBlocked || latest.scope !== 'workspace' || readIssueMetadata(latest.content).deletedAt) return { error: 'linearIssueInvalid' as const }
    // Never relabel a retired claim as current work. Supersede any stale open
    // row before inserting into the issue-wide partial unique index.
    await tx.update(linearSyncOutbox).set({ status: 'done', claimToken: null, updatedAt: new Date() })
      .where(and(eq(linearSyncOutbox.issueId, issue.id), sql`${linearSyncOutbox.scopeVersion} <> ${latest.scopeVersion}`, sql`${linearSyncOutbox.status} in ('queued', 'processing')`))
    const [open] = await tx.select({ id: linearSyncOutbox.id }).from(linearSyncOutbox)
      .where(and(eq(linearSyncOutbox.issueId, issue.id), eq(linearSyncOutbox.scopeVersion, latest.scopeVersion), sql`${linearSyncOutbox.status} in ('queued', 'processing')`)).limit(1)
    if (!open) {
      const [failed] = await tx.select({ id: linearSyncOutbox.id }).from(linearSyncOutbox)
        .where(and(eq(linearSyncOutbox.issueId, issue.id), eq(linearSyncOutbox.status, 'failed'), eq(linearSyncOutbox.scopeVersion, latest.scopeVersion))).orderBy(desc(linearSyncOutbox.updatedAt)).limit(1)
      if (failed) await tx.update(linearSyncOutbox).set({ status: 'queued', claimToken: null, attempts: 0, availableAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(linearSyncOutbox.id, failed.id))
      else await tx.insert(linearSyncOutbox).values({ id: crypto.randomUUID(), issueId: issue.id, scopeVersion: latest.scopeVersion }).onConflictDoNothing()
    }
    await tx.update(linearIssueLinks).set({ syncStatus: 'pending', lastError: null, updatedAt: new Date() }).where(eq(linearIssueLinks.issueId, issue.id))
    return { success: true as const }
  })
  if ('error' in result) return result
  dispatchLinearIssueSync(issue.id)
  return { success: true as const }
}

export async function retryLinearDelivery(deliveryId: string) {
  const user = await requireUser()
  const parsed = z.string().min(1).max(200).safeParse(deliveryId)
  if (!parsed.success) return { error: 'linearDeliveryInvalid' as const }
  const [delivery] = await db.select({ id: linearSyncInbox.deliveryId }).from(linearSyncInbox)
    .innerJoin(linearConnections, and(eq(linearConnections.organizationId, linearSyncInbox.organizationId), eq(linearConnections.userId, user.id)))
    .where(and(eq(linearSyncInbox.deliveryId, parsed.data), eq(linearSyncInbox.status, 'failed'), isNull(linearConnections.revokedAt))).limit(1)
  if (!delivery) return { error: 'linearDeliveryUnavailable' as const }
  await db.update(linearSyncInbox).set({ status: 'queued', attempts: 0, availableAt: new Date(), lastError: null }).where(eq(linearSyncInbox.deliveryId, delivery.id))
  dispatchLinearWebhook(delivery.id)
  return { success: true as const }
}

export async function disconnectLinearAccount() {
  const user = await requireUser()
  await disconnectLinear(user.id)
  return { success: true as const }
}
