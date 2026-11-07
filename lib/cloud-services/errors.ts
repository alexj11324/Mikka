import { CodedError } from '@mikka/protocol/coded-error'

export const CLOUD_ERROR_CODES = ['cloud_not_connected', 'cloud_scope_missing', 'cloud_server_revoked', 'cloud_invalid_request', 'cloud_rate_limited', 'cloud_access_denied', 'cloud_unavailable', 'cloud_quota_exhausted'] as const
export type CloudErrorCode = typeof CLOUD_ERROR_CODES[number]
export type CloudErrorDetail = 'configuration' | 'network' | 'response' | 'protocol' | 'state' | 'origin' | 'session' | 'administrator' | 'storage' | 'refresh_uncertain'
export class CloudServiceError extends CodedError<CloudErrorCode, CloudErrorDetail> {
  constructor(code: CloudErrorCode, detail?: CloudErrorDetail, cause?: unknown) { super(code, { detail, cause }) }
}
export function cloudErrorCode(value: unknown): CloudErrorCode | null {
  return typeof value === 'string' && (CLOUD_ERROR_CODES as readonly string[]).includes(value) ? value as CloudErrorCode : null
}
export function cloudErrorStatus(code: CloudErrorCode) {
  if (code === 'cloud_access_denied' || code === 'cloud_scope_missing') return 403
  if (code === 'cloud_server_revoked' || code === 'cloud_not_connected') return 401
  if (code === 'cloud_rate_limited') return 429
  if (code === 'cloud_quota_exhausted') return 402
  return code === 'cloud_invalid_request' ? 400 : 503
}
