import { isDeviceAuthorityError } from '@/lib/db/device-scope'
import { classifyRunGitHubFailure, logRunGitHubFailure } from './run-token-failure'

/** The run whose owner's own GitHub credential is asked for. Server-derived; the request names nothing. */
export interface RunGitHubScope {
  runId: string
  userId: string
  /** The run's own repository. Cloud installation credentials use its owning installation. */
  remoteKey?: string
}

const GITHUB_REMOTE_PREFIX = 'v2/github.com/'
/** The longest a worker keeps one answer; it asks again after this. */
const MAX_ANSWER_MS = 60 * 60_000
/** A gh watch segment needs its credential this long (packages/daemon/src/agents/github-credentials.mjs). */
export const RUN_GITHUB_MIN_VALIDITY_MS = 45 * 60_000

/**
 * The run owner's own GitHub user token, like `gh auth login` on their own
 * computer (decision 2026-11-02-1600): every repository they authorized, for
 * any run of theirs, read-only or not. It is the person's own credential, so
 * nothing revokes it when a run ends; the run token stops working instead.
 */
export function createRunGitHubTokenExchange(deps: {
  authorize(request: Request): Promise<RunGitHubScope | null>
  issue(userId: string, scope: RunGitHubScope): Promise<{ token: string; expiresAt: Date | null; githubAccountId?: string; installationId?: string }>
  /** Bookkeeping after a successful answer; a failure here never withholds the token. */
  afterIssue?(scope: RunGitHubScope, issued: { token: string; githubAccountId?: string; installationId?: string }): Promise<void>
  /** Direct machine credentials refresh at the provider's natural expiry. */
  naturalExpiry?: boolean
  /** Where a failure's structured line goes; the server log by default. */
  log?: (line: string) => void
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  return async (request: Request): Promise<Response> => {
    const headers = { 'cache-control': 'no-store', pragma: 'no-cache' }
    const denied = () => Response.json({ error: 'runGitHubAccessDenied' }, { status: 403, headers })
    let runId: string | null = null
    let stage: 'authorize' | 'issue' | 'reauthorize' = 'authorize'
    try {
      const scope = await deps.authorize(request)
      if (!scope) return denied()
      runId = scope.runId
      stage = 'issue'
      const issued = await deps.issue(scope.userId, scope)
      // The run may have ended or changed hands during GitHub IO.
      stage = 'reauthorize'
      const current = await deps.authorize(request)
      if (!current || current.runId !== scope.runId || current.userId !== scope.userId || current.remoteKey !== scope.remoteKey) return denied()
      await deps.afterIssue?.(current, issued).catch(() => undefined)
      const cap = now() + MAX_ANSWER_MS
      const expiresAt = deps.naturalExpiry ? issued.expiresAt?.toISOString() ?? null
        : new Date(issued.expiresAt ? Math.min(issued.expiresAt.getTime(), cap) : cap).toISOString()
      // Daemons up to 0.0.315 check that the answer names the run's repository
      // (their claim's github.repository) and refuse it otherwise, so a clone
      // fails with git asking for a username. Keep naming it; it scopes nothing.
      const repository = current.remoteKey?.startsWith(GITHUB_REMOTE_PREFIX) ? current.remoteKey.slice(GITHUB_REMOTE_PREFIX.length) : undefined
      return Response.json({ token: issued.token, expiresAt, ...(repository ? { repository } : {}) }, { headers })
    } catch (error) {
      // A revoked device token (a desktop's worker credential) is an authentication failure: withDeviceRoute answers 401.
      if (isDeviceAuthorityError(error)) throw error
      // Never expose a provider body, token or fetch exception to a worker or a log: only the code.
      const failure = classifyRunGitHubFailure(error)
      logRunGitHubFailure(failure, { runId, stage }, deps.log)
      return Response.json({ error: failure.code }, { status: failure.status, headers })
    }
  }
}
