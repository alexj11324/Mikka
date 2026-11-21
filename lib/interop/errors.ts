import { CodedError } from '@mikka/protocol/coded-error'
import { USER_ERROR_CODES } from '@mikka/protocol/user-error-codes'

/**
 * Agent/Bot interop refusals (decision 2026-11-19-2200). A missing resource and
 * a resource the principal may not use are the same `interop_not_found`, so a
 * caller cannot probe another person's ids.
 */
const INTEROP_CODES = ['interop_not_found', 'interop_invalid_request', 'interop_scope_required', 'interop_send_unavailable',
  'interop_diff_unavailable', 'interop_drive_conflict', 'interop_drive_unavailable'] as const
/** The interop codes and their details, as registered for user copy (`RunErrors.*`). */
export const INTEROP_ERRORS: Pick<typeof USER_ERROR_CODES, typeof INTEROP_CODES[number]> =
  Object.fromEntries(INTEROP_CODES.map(code => [code, USER_ERROR_CODES[code]])) as Pick<typeof USER_ERROR_CODES, typeof INTEROP_CODES[number]>

export type InteropErrorCode = keyof typeof INTEROP_ERRORS
export type InteropErrorDetail = (typeof INTEROP_ERRORS)[InteropErrorCode][number]

export const INTEROP_ERROR_STATUS: Record<InteropErrorCode, number> = {
  interop_not_found: 404,
  interop_invalid_request: 400,
  interop_scope_required: 403,
  interop_send_unavailable: 409,
  interop_diff_unavailable: 409,
  interop_drive_conflict: 409,
  interop_drive_unavailable: 413,
}

export class InteropError extends CodedError<InteropErrorCode, InteropErrorDetail> {
  constructor(code: InteropErrorCode, options: { detail?: InteropErrorDetail; cause?: unknown } = {}) {
    super(code, options)
    this.name = 'InteropError'
  }
  get status(): number { return INTEROP_ERROR_STATUS[this.code] }
}
