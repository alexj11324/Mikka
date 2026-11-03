/** A GitHub access failure as a code and status only; never a provider body or token. */
export type GitHubAccessCode = 'authRequired' | 'githubNotConfigured' | 'githubNotConnected' | 'githubReconnectRequired' | 'githubRepositoryForbidden' | 'githubPullRequestInvalid' | 'githubIssueInvalid' | 'githubUnavailable'

export class GitHubAccessError extends Error {
  constructor(readonly code: GitHubAccessCode, readonly status: number) {
    super(code)
    this.name = 'GitHubAccessError'
  }
}
