import 'server-only'
import type { PoolClient } from 'pg'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { daemonTestMode } from '@mikka/protocol/repository'
import type { RunInvalidReason } from '@/lib/run-invalid-reason'
import { linkedGitHubAccountId } from './repository-installation'
import { PublicationError, verifyGitHubPushAccess, type PublicationErrorCode } from './run-pull-request'

/**
 * Push authority (decision 2026-11-01-1215-push-by-github-app): what the
 * person already granted on GitHub. The Mikka GitHub App's installation on the
 * repository grants contents:write, and the person's own linked GitHub account
 * may write to it. Mikka asks for nothing on top.
 *
 * A dispatch checks GitHub live (verifyPushGrant) before its admission
 * transaction and records the outcome on the person's repository installation
 * row; admission reads that record (recordedPushGrant). A definite refusal
 * refuses at once. When GitHub cannot answer, a grant recorded in the last
 * PUSH_GRANT_MAX_AGE_MS still admits. The run's GitHub token and the pull
 * request check GitHub live again.
 */

/** A host dispatch inside its own transaction (Factory) relies on a check this recent. */
export const PUSH_GRANT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type PushGrantRefusal = Extract<RunInvalidReason, 'githubAppNotInstalled' | 'githubAppPermissionRequired' | 'githubAppSuspended' | 'githubIdentityRequired' | 'githubAccessDenied' | 'repositoryNotGithub' | 'githubUnavailable' | 'githubNotConfigured'>

const REFUSALS: Partial<Record<PublicationErrorCode, PushGrantRefusal>> = {
  github_not_installed: 'githubAppNotInstalled',
  github_permission_required: 'githubAppPermissionRequired',
  github_suspended: 'githubAppSuspended',
  github_identity_required: 'githubIdentityRequired',
  github_access_denied: 'githubAccessDenied',
  repository_not_github: 'repositoryNotGithub',
  github_not_configured: 'githubNotConfigured',
}

/** A file origin exists only in an isolated test environment; it has no GitHub App, so nothing withholds its push. */
const testFileOrigin = (remoteKey: string) => remoteKey.startsWith('v2/file/') && daemonTestMode(process.env)

/** What GitHub says now, recorded for admission. A GitHub outage records nothing. */
export async function verifyPushGrant(userId: string, remoteKey: string, options: { fetcher?: typeof fetch; env?: Record<string, string | undefined> } = {}): Promise<{ granted: true } | { granted: false; reason: PushGrantRefusal }> {
  if (testFileOrigin(remoteKey)) return { granted: true }
  // Nothing to look up when the repository is not on GitHub or this server has no App.
  if (!remoteKey.startsWith('v2/github.com/')) return { granted: false, reason: 'repositoryNotGithub' }
  const env = options.env ?? process.env
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return { granted: false, reason: 'githubNotConfigured' }
  try {
    const binding = await verifyGitHubPushAccess({ remoteKey, githubAccountId: await linkedGitHubAccountId(userId), ...options })
    await db.execute(sql`insert into github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId","verifiedAt","pushGrantedAt")
      values (${userId}, ${remoteKey}, ${binding.githubAccountId}, ${binding.installationId}, ${binding.repositoryId}, now(), now())
      on conflict ("userId","remoteKey") do update set "githubAccountId"=excluded."githubAccountId", "installationId"=excluded."installationId",
        "repositoryId"=excluded."repositoryId", "verifiedAt"=excluded."verifiedAt", "pushGrantedAt"=excluded."pushGrantedAt"`)
    return { granted: true }
  } catch (error) {
    if (!(error instanceof PublicationError)) throw error
    const reason = REFUSALS[error.code] ?? 'githubUnavailable'
    // An unexpected GitHub answer is still treated as "could not check", but the cause stays visible to whoever runs the server.
    if (!error.retryable && reason === 'githubUnavailable') console.error('Push grant check failed', { code: error.code, status: error.status })
    if (reason !== 'githubUnavailable' && reason !== 'githubNotConfigured')
      await db.execute(sql`update github_repository_installations set "pushGrantedAt"=null where "userId"=${userId} and "remoteKey"=${remoteKey}`)
    return { granted: false, reason }
  }
}

/** Inside the admission transaction: the recorded grant for this person's current GitHub account, if recent enough. */
export async function recordedPushGrant(client: PoolClient, userId: string, remoteKey: string, now: Date, maxAgeMs = PUSH_GRANT_MAX_AGE_MS): Promise<{ grantedAt: string } | null> {
  if (testFileOrigin(remoteKey)) return { grantedAt: now.toISOString() }
  const { rows: [row] } = await client.query<{ grantedAt: Date | null; githubAccountId: string; linked: string | null }>(`SELECT g."pushGrantedAt" AS "grantedAt", g."githubAccountId",
      (SELECT "accountId" FROM (SELECT 0 AS rank, "githubAccountId" AS "accountId" FROM github_connections WHERE "userId"=$1
        UNION ALL (SELECT 1, "accountId" FROM account WHERE "userId"=$1 AND "providerId"='github' ORDER BY "createdAt" LIMIT 1)) linked ORDER BY rank LIMIT 1) AS linked
    FROM github_repository_installations g WHERE g."userId"=$1 AND g."remoteKey"=$2 FOR SHARE OF g`, [userId, remoteKey])
  if (!row?.grantedAt || row.linked !== row.githubAccountId || now.getTime() - row.grantedAt.getTime() > maxAgeMs) return null
  return { grantedAt: row.grantedAt.toISOString() }
}
