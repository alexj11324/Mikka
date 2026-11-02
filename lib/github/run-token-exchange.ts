import { isDeviceAuthorityRevoked } from '@/lib/db/device-scope'
import { classifyRunGitHubFailure, logRunGitHubFailure } from './run-token-failure'

/** The run whose owner's own GitHub credential is asked for. Server-derived; the request names nothing. */
export interface RunGitHubScope {
  runId: string
  userId: string
  /** The run's own github.com repository, for bookkeeping only; it scopes nothing. */
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
  issue(userId: string): Promise<{ token: string; expiresAt: Date | null; githubAccountId?: string }>
  /** Bookkeeping after a successful answer; a failure here never withholds the token. */
  afterIssue?(scope: RunGitHubScope, issued: { token: string; githubAccountId?: string }): Promise<void>
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
      const issued = await deps.issue(scope.userId)
      // The run may have ended or changed hands during GitHub IO.
      stage = 'reauthorize'
      const current = await deps.authorize(request)
      if (!current || current.runId !== scope.runId || current.userId !== scope.userId) return denied()
      await deps.afterIssue?.(current, issued).catch(() => undefined)
      const cap = now() + MAX_ANSWER_MS
      const expiresAt = new Date(issued.expiresAt ? Math.min(issued.expiresAt.getTime(), cap) : cap).toISOString()
      // Daemons up to 0.0.315 check that the answer names the run's repository
      // (their claim's github.repository) and refuse it otherwise, so a clone
      // fails with git asking for a username. Keep naming it; it scopes nothing.
      const repository = current.remoteKey?.startsWith(GITHUB_REMOTE_PREFIX) ? current.remoteKey.slice(GITHUB_REMOTE_PREFIX.length) : undefined
      return Response.json({ token: issued.token, expiresAt, ...(repository ? { repository } : {}) }, { headers })
    } catch (error) {
      // A revoked device token (a desktop's worker credential) is an authentication failure: withDeviceRoute answers 401.
      if (isDeviceAuthorityRevoked(error)) throw error
      // Never expose a provider body, token or fetch exception to a worker or a log: only the code.
      const failure = classifyRunGitHubFailure(error)
      logRunGitHubFailure(failure, { runId, stage }, deps.log)
      return Response.json({ error: failure.code }, { status: failure.status, headers })
    }
  }
}
