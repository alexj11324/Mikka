import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { linearConnections } from '@/lib/db/schema'
import { getComposio } from '@/lib/composio'
import { toConnectedAccountView } from '@/lib/composio-accounts'
import { listComposioPages } from '@/lib/composio-pagination'
import { GitHubAccessError, listAuthorizedRepositories } from '@/lib/github/user-access'
import { linearSyncState } from '@/lib/linear-sync/flags'
import { linearOAuthConfigured } from '@/lib/linear-sync/oauth'
import { readTelegramIntegrationStatus } from '@/lib/telegram/connection-status'

async function github(userId: string, headers: Headers) {
  try {
    const result = await listAuthorizedRepositories(headers)
    if (result.userId !== userId) throw new GitHubAccessError('authRequired', 401)
    return result.installations.length ? ['github'] : []
  } catch (error) {
    if (error instanceof GitHubAccessError && (error.code === 'githubNotConnected' || error.code === 'githubNotConfigured')) return []
    throw error
  }
}

async function linear(userId: string) {
  const state = await linearSyncState()
  // R-40 leaves a paused service visible without reading the person's connection table.
  if (state !== 'enabled') return 'paused'
  if (!linearOAuthConfigured()) return 'notConnected'
  const [row] = await db.select({ id: linearConnections.userId }).from(linearConnections)
    .where(and(eq(linearConnections.userId, userId), isNull(linearConnections.revokedAt))).limit(1)
  return row ? 'connected' : 'notConnected'
}

async function composioAccounts(userId: string) {
  const composio = getComposio()
  if (!composio) return []
  const rows = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], cursor }))
  return rows.flatMap(row => {
    const view = toConnectedAccountView(row)
    return view ? [view.toolkit] : []
  })
}

export async function mobilePluginConnections(userId: string, headers: Headers) {
  const sources = ['composio', 'github', 'linear', 'telegram'] as const
  const paused: string[] = []
  const reads = await Promise.allSettled([
    composioAccounts(userId), github(userId, headers),
    linear(userId).then(state => {
      if (state === 'paused') paused.push('linear')
      return state === 'connected' ? ['linear'] : []
    }),
    readTelegramIntegrationStatus(userId).then(state => state.configured && state.connected ? ['telegram'] : []),
  ])
  const toolkits = new Set<string>()
  const failed: { source: typeof sources[number]; reason: string }[] = []
  reads.forEach((read, index) => {
    if (read.status === 'fulfilled') for (const id of read.value) toolkits.add(id)
    else failed.push({ source: sources[index], reason: read.reason instanceof GitHubAccessError ? read.reason.code : read.reason instanceof Error ? read.reason.name : 'unknown' })
  })
  return { toolkits: [...toolkits], paused, failed }
}
