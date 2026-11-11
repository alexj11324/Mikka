import type { ActionErrorCode, ActionErrorParams, ActionResult } from './action-result'

export class ActionFailureError extends Error {
  constructor(readonly code: ActionErrorCode, readonly params?: ActionErrorParams,
    /** The caller may replay this exact action with `confirmAccess: true`. */
    readonly confirmable?: true) {
    super(code)
    this.name = 'ActionFailureError'
  }
}

/**
 * Converts an expected action failure into a returned code. Anything else is a
 * programming error and keeps propagating, so it still shows up in server logs.
 */
export async function runAction<T>(fn: () => Promise<T | ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn() as ActionResult<T>
  } catch (error) {
    // `confirmable` is present only on a refusal the caller may replay, so an
    // ordinary failure keeps exactly the shape its callers already compare.
    if (error instanceof ActionFailureError) return error.confirmable
      ? { error: error.code, params: error.params, confirmable: error.confirmable }
      : { error: error.code, params: error.params }
    throw error
  }
}
