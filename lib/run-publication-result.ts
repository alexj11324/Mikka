/** Safe, actionable outcomes. GitHub bodies, credentials and fetch errors never reach logs or chat. */
export const PUBLICATION_ERRORS = {
  github_not_configured: 'The GitHub App is not configured.',
  github_identity_required: 'Connect GitHub in Plugins › GitHub.',
  github_reconnect_required: 'Reconnect GitHub in Plugins › GitHub.',
  github_not_installed: 'Install the Mikka GitHub App on this repository.',
  github_permission_required: 'The GitHub App installation needs pull_requests: write and contents: read.',
  github_suspended: 'The GitHub App installation is suspended.',
  github_access_denied: 'The connected GitHub account cannot reach this repository.',
  github_unavailable: 'GitHub is temporarily unavailable. The pushed branch is preserved.',
  github_request_failed: 'GitHub could not complete the pull request request.',
  repository_not_github: 'Automatic pull requests currently require a github.com repository.',
  branch_not_pushed: 'GitHub has not received the reported branch commit.',
  branch_changed: 'The issue branch changed after this thread pushed. Check the newer thread.',
  pull_request_conflict: 'This branch already belongs to a different pull request.',
  push_not_approved: 'This thread was not admitted to push.',
  push_failed: 'The local git push did not succeed. Check the thread report and local git credentials.',
  task_identifier_required: 'The task needs its team identifier and number before publication.',
  publication_missing: 'This thread has no server-issued publication assignment.',
  publication_mismatch: 'The reported push does not match the server-issued issue branch.',
  factory_public_evidence_required: 'Record visual evidence, check it contains no private data, and mark it safe to share before handing over the pull request.',
  issue_unavailable: 'The task is no longer available to this thread.',
  pull_request_limit: 'The task already has the maximum number of pull request links.',
  pull_request_denied: 'Opening pull requests is set to deny in Plugins › GitHub. The pushed branch is preserved.',
  pull_request_setting_unavailable: 'The pull request setting could not be read. The pushed branch is preserved and opening is retried.',
} as const
export type PublicationErrorCode = keyof typeof PUBLICATION_ERRORS

export class PublicationError extends Error {
  /** `status` is GitHub's HTTP status when GitHub answered, for server logs only. */
  constructor(readonly code: PublicationErrorCode, readonly retryable = false, readonly status?: number) {
    super(PUBLICATION_ERRORS[code])
    this.name = 'PublicationError'
  }
}

export interface PublishedPullRequest {
  /** Present for deliveries recorded after #541. */
  title?: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  /** Lines added and removed, when GitHub's reply carried them (a single PR does; a list of PRs does not). */
  /** Host receipt: returned only after the PR description contains these exact capture links. */
  evidenceDigest?: string
  additions?: number
  deletions?: number
  /** Review metadata synchronized during publication or a verified webhook. */
  branch?: string
  headSha?: string
  changedFiles?: number
  reviewChecks?: import('./github/review-checks').ReviewChecks | null
}
