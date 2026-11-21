import type { ActionErrorCode } from './action-result'

/**
 * HTTP status for an action's failure, so every transport answers the same
 * status for the same code. `confirmAccess` (ALE-26) is a conflict: the request
 * is well-formed and authorized, but it would change who can read a resource,
 * so it is refused until the caller replays it with `confirmAccess: true`.
 */
export const ACTION_ERROR_STATUS: Partial<Record<ActionErrorCode, number>> = {
  authRequired: 401,
  accessChangeConfirmationRequired: 409,
}

export function actionErrorStatus(code: ActionErrorCode): number {
  return ACTION_ERROR_STATUS[code] ?? 400
}
