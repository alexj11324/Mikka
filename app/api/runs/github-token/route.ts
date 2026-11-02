import { authorizeRunGitHubToken } from '@/lib/github/run-token-authority'
import { createRunGitHubTokenExchange, RUN_GITHUB_MIN_VALIDITY_MS } from '@/lib/github/run-token-exchange'
import { githubTokenForUser } from '@/lib/github/user-access'
import { recordRepositoryInstallation, repositoryInstallationFresh } from '@/lib/github/repository-installation'

export const dynamic = 'force-dynamic'

export const POST = createRunGitHubTokenExchange({
  authorize: authorizeRunGitHubToken,
  issue: userId => githubTokenForUser(userId, { minValidityMs: RUN_GITHUB_MIN_VALIDITY_MS }),
  // The run's repository installation, at most once a day per person and repository.
  afterIssue: async (scope, issued) => {
    if (!scope.remoteKey || !issued.githubAccountId || await repositoryInstallationFresh(scope.userId, scope.remoteKey)) return
    await recordRepositoryInstallation(scope.userId, scope.remoteKey, { token: issued.token, githubAccountId: issued.githubAccountId })
  },
})
