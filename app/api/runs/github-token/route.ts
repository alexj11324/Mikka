import { authorizeRunGitHubToken } from '@/lib/github/run-token-authority'
import { createRunGitHubTokenExchange } from '@/lib/github/run-token-exchange'
import { issueRunGitHubInstallationToken, revokeRunGitHubInstallationToken } from '@/lib/github/run-pull-request'

export const dynamic = 'force-dynamic'

export const POST = createRunGitHubTokenExchange({
  authorize: authorizeRunGitHubToken,
  issue: issueRunGitHubInstallationToken,
  revoke: revokeRunGitHubInstallationToken,
})
