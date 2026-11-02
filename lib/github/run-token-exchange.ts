import type { issueRunGitHubInstallationToken } from './run-pull-request'
import { classifyRunGitHubFailure, logRunGitHubFailure } from './run-token-failure'

export interface RunGitHubScope {
  runId: string
  userId: string
  remoteKey: string
  branch: string
  githubAccountId: string
}

/** Authorization is server-derived; the request cannot choose a repository. */
export function createRunGitHubTokenExchange(deps: {
  authorize(request: Request): Promise<RunGitHubScope | null>
  issue: typeof issueRunGitHubInstallationToken
  revoke(token: string): Promise<void>
  /** Where a failure's structured line goes; the server log by default. */
  log?: (line: string) => void
}) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'cache-control': 'no-store', pragma: 'no-cache' }
    const denied = () => Response.json({ error: 'runGitHubAccessDenied' }, { status: 403, headers })
    let issued: Awaited<ReturnType<typeof deps.issue>> | undefined
    let runId: string | null = null
    let stage: 'authorize' | 'issue' | 'reauthorize' = 'authorize'
    try {
      const scope = await deps.authorize(request)
      if (!scope) return denied()
      runId = scope.runId
      stage = 'issue'
      issued = await deps.issue({ remoteKey: scope.remoteKey, githubAccountId: scope.githubAccountId })
      stage = 'reauthorize'
      const current = await deps.authorize(request)
      if (!current || current.runId !== scope.runId || current.userId !== scope.userId ||
        current.remoteKey !== scope.remoteKey || current.branch !== scope.branch || current.githubAccountId !== scope.githubAccountId) {
        await deps.revoke(issued.token)
        issued = undefined
        return denied()
      }
      return Response.json({ ...issued, repository: scope.remoteKey.slice('v2/github.com/'.length), branch: scope.branch }, { headers })
    } catch (error) {
      // Never expose a provider body, token or fetch exception to a worker or a log:
      // only the failure's category, GitHub's status and the code the daemon can explain.
      if (issued) await deps.revoke(issued.token).catch(() => undefined)
      const failure = classifyRunGitHubFailure(error)
      logRunGitHubFailure(failure, { runId, stage }, deps.log)
      return Response.json({ error: failure.code }, { status: failure.status, headers })
    }
  }
}
