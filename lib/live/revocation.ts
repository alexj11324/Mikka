/** Closed control message on the existing authenticated live push endpoint. */
export const LIVE_REVOKE = { type: 'live_revoked' } as const

export function liveRevocation(value: unknown): value is typeof LIVE_REVOKE {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { type?: unknown }).type === LIVE_REVOKE.type
}
