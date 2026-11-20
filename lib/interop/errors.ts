import { CodedError } from '@mikka/protocol/coded-error'

/**
 * Agent/Bot interop refusals (decision 2026-11-19-2200). A missing resource and
 * a resource the principal may not use are the same `interop_not_found`, so a
 * caller cannot probe another person's ids.
 */
export const INTEROP_ERRORS = {
  interop_not_found: [],
  interop_invalid_request: [],
  interop_scope_required: [],
  interop_send_unavailable: ['run_not_active', 'thread_replaced', 'thread_cannot_continue', 'delivery_unavailable', 'bot_unavailable'],
  interop_diff_unavailable: ['no_checkpoint', 'masked'],
} as const satisfies Record<string, readonly string[]>

export type InteropErrorCode = keyof typeof INTEROP_ERRORS
export type InteropErrorDetail = (typeof INTEROP_ERRORS)[InteropErrorCode][number]

export const INTEROP_ERROR_STATUS: Record<InteropErrorCode, number> = {
  interop_not_found: 404,
  interop_invalid_request: 400,
  interop_scope_required: 403,
  interop_send_unavailable: 409,
  interop_diff_unavailable: 409,
}

export class InteropError extends CodedError<InteropErrorCode, InteropErrorDetail> {
  constructor(code: InteropErrorCode, options: { detail?: InteropErrorDetail; cause?: unknown } = {}) {
    super(code, options)
    this.name = 'InteropError'
  }
  get status(): number { return INTEROP_ERROR_STATUS[this.code] }
}
