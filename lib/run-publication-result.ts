/** Safe, actionable outcomes. GitHub bodies, credentials and fetch errors never reach logs or chat. */
export const PUBLICATION_ERRORS = {
  github_not_configured: 'The GitHub App is not configured.',
  github_identity_required: 'Connect a GitHub account with write access to this repository.',
  github_not_installed: 'Install the Mikka GitHub App on this repository.',
  github_permission_required: 'The GitHub App installation needs pull_requests: write and contents: read.',
  github_suspended: 'The GitHub App installation is suspended.',
  github_access_denied: 'The connected GitHub account does not have write access to this repository.',
  github_unavailable: 'GitHub is temporarily unavailable. The pushed branch is preserved.',
  github_request_failed: 'GitHub could not complete the pull request request.',
  repository_not_github: 'Automatic pull requests currently require a github.com repository.',
  branch_not_pushed: 'GitHub has not received the reported branch commit.',
  branch_changed: 'The issue branch changed after this thread pushed. Check the newer thread.',
  pull_request_conflict: 'This branch already belongs to a different pull request.',
  push_not_approved: 'Push needs approval for this repository.',
  push_failed: 'The local git push did not succeed. Check the thread report and local git credentials.',
  task_identifier_required: 'The task needs its team identifier and number before publication.',
  publication_missing: 'This thread has no server-issued publication assignment.',
  publication_mismatch: 'The reported push does not match the server-issued issue branch.',
  issue_unavailable: 'The task is no longer available to this thread.',
  pull_request_limit: 'The task already has the maximum number of pull request links.',
} as const
export type PublicationErrorCode = keyof typeof PUBLICATION_ERRORS

export class PublicationError extends Error {
  constructor(readonly code: PublicationErrorCode, readonly retryable = false) {
    super(PUBLICATION_ERRORS[code])
    this.name = 'PublicationError'
  }
}

export interface PublishedPullRequest {
  /** Present for deliveries recorded after #541. */
  title?: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
}
