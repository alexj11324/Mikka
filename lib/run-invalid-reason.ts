/**
 * Why run admission refused a dispatch (`runInvalid`). The Coordinator gets the
 * reason and its detail with the error, so it acts on the real cause instead
 * of guessing one.
 */
export const RUN_INVALID_REASONS = {
  // Push is what the person granted on GitHub (lib/github/push-grant.ts). Each of these
  // is fixed on GitHub, never by an approval in Mikka; a readOnly run needs none of it.
  githubAppNotInstalled: 'The Mikka GitHub App is not installed on this repository. The person installs it on GitHub: https://github.com/apps/mikka-github/installations/new. A readOnly run can go ahead now.',
  githubAppPermissionRequired: 'The Mikka GitHub App installation on this repository does not grant contents: write. The person extends it on GitHub (accept the requested permissions, or add the repository): https://github.com/apps/mikka-github/installations/new. A readOnly run can go ahead now.',
  githubAppSuspended: 'The Mikka GitHub App installation on this repository is suspended on GitHub. The person unsuspends it in their GitHub installation settings.',
  githubIdentityRequired: 'The person has no GitHub account connected to Mikka. They connect it in Plugins › GitHub.',
  githubAccessDenied: 'The person\'s connected GitHub account cannot write to this repository. Pushing needs their own write access on GitHub.',
  repositoryNotGithub: 'Only github.com repositories can be pushed, through the Mikka GitHub App. A readOnly run can go ahead.',
  githubUnavailable: 'GitHub could not be reached to check the App installation. Try the dispatch again shortly.',
  githubNotConfigured: 'The Mikka GitHub App is not configured on this server.',
  githubPushUnverified: 'Mikka has no recent check that the Mikka GitHub App may push to this repository. Dispatching it from chat checks GitHub again.',
  repositoryPushDenied: 'Pushing is turned off by this workspace\'s policy or a read-only mode. Only a readOnly run can be dispatched.',
  taskDestinationMismatch: 'The task was sent to a different place than this device.',
  issueUnavailable: 'The task is no longer available to this person.',
  deviceUnavailable: 'The device or its execution tool is unavailable.',
  repositoryMismatch: 'The repository does not match the device checkout or the approved repository.',
  botUnavailable: 'The bot that dispatched this run is unavailable.',
  sourceRunMismatch: 'An earlier run for this request does not match this dispatch.',
  taskIdentifierRequired: 'The task has no identifier for its branch.',
  branchInUse: 'The task branch is already used by another task in this repository.',
} as const

export type RunInvalidReason = keyof typeof RUN_INVALID_REASONS

export function runInvalidDetail(reason: unknown): string | undefined {
  return typeof reason === 'string' && Object.hasOwn(RUN_INVALID_REASONS, reason) ? RUN_INVALID_REASONS[reason as RunInvalidReason] : undefined
}
