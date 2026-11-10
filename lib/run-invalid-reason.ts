/**
 * Why run admission refused a dispatch (`runInvalid`). The Coordinator gets the
 * reason and its detail with the error, so it acts on the real cause instead
 * of guessing one.
 */
export const RUN_INVALID_REASONS = {
  taskDestinationMismatch: 'The task was sent to a different place than this device.',
  issueUnavailable: 'The task is no longer available to this person.',
  deviceUnavailable: 'The device or its execution tool is unavailable.',
  repositoryMismatch: 'The repository does not match the device checkout.',
  botUnavailable: 'The bot that dispatched this run is unavailable.',
  sourceRunMismatch: 'An earlier run for this request does not match this dispatch.',
  taskIdentifierRequired: 'The task has no identifier for its branch.',
  branchInUse: 'The task branch is already used by another task in this repository.',
  threadModeLocked: 'The thread is still working; change its mode after it ends.',
  threadModeChanged: 'The thread mode changed; reload it and try again.',
} as const

export type RunInvalidReason = keyof typeof RUN_INVALID_REASONS

export function runInvalidDetail(reason: unknown): string | undefined {
  return typeof reason === 'string' && Object.hasOwn(RUN_INVALID_REASONS, reason) ? RUN_INVALID_REASONS[reason as RunInvalidReason] : undefined
}
