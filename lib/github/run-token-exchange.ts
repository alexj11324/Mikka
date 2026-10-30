import type { issueRunGitHubInstallationToken } from './run-pull-request'

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
}) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'cache-control': 'no-store', pragma: 'no-cache' }
    const denied = () => Response.json({ error: 'runGitHubAccessDenied' }, { status: 403, headers })
    let issued: Awaited<ReturnType<typeof deps.issue>> | undefined
    try {
      const scope = await deps.authorize(request)
      if (!scope) return denied()
      issued = await deps.issue({ remoteKey: scope.remoteKey, githubAccountId: scope.githubAccountId })
      const current = await deps.authorize(request)
      if (!current || current.runId !== scope.runId || current.userId !== scope.userId ||
        current.remoteKey !== scope.remoteKey || current.branch !== scope.branch || current.githubAccountId !== scope.githubAccountId) {
        await deps.revoke(issued.token)
        issued = undefined
        return denied()
      }
      return Response.json({ ...issued, repository: scope.remoteKey.slice('v2/github.com/'.length), branch: scope.branch }, { headers })
    } catch {
      // Never expose a provider body, token or fetch exception to a worker.
      if (issued) await deps.revoke(issued.token).catch(() => undefined)
      return Response.json({ error: 'runGitHubUnavailable' }, { status: 502, headers })
    }
  }
}
