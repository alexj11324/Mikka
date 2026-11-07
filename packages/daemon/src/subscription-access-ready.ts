import type { CredentialScope, WorkerConfiguration } from './subscription-worker-client'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('subscription_access_unavailable')
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/.test(value)
const unix = (value: unknown): number | undefined => {
  const numeric = typeof value === 'number' ? Math.trunc(value) : typeof value === 'string' && /^\s*\+?\d+\s*$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return
  const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1_000
  return Number.isSafeInteger(ms) ? ms : undefined
}
function date(value: unknown): number | undefined {
  const numeric = unix(value)
  if (numeric !== undefined) return numeric
  if (typeof value !== 'string') return
  // CPA accepts RFC3339 with a zone, or its two UTC space-separated layouts.
  // Date.parse alone also accepts absent zones and normalizes invalid days.
  const match = /^(\d{4})-(\d{2})-(\d{2})(T| )(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim())
  if (!match || (match[4] === 'T' ? !match[7] || !match[9] : Boolean(match[9]))) return
  const [, year, month, day, , hour, minute, second = '0', fraction = '', zone] = match
  const instant = new Date(0)
  instant.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  instant.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0').slice(0, 3)))
  if (instant.getUTCFullYear() !== Number(year) || instant.getUTCMonth() !== Number(month) - 1 || instant.getUTCDate() !== Number(day) || instant.getUTCHours() !== Number(hour) || instant.getUTCMinutes() !== Number(minute) || instant.getUTCSeconds() !== Number(second)) return
  if (!zone || zone === 'Z') return instant.getTime()
  const zoneHours = Number(zone.slice(1, 3)), zoneMinutes = Number(zone.slice(4, 6))
  if (zoneHours > 23 || zoneMinutes > 59) return
  return instant.getTime() - (zone[0] === '+' ? 1 : -1) * (zoneHours * 60 + zoneMinutes) * 60_000
}
function jwtExpiry(token: string): number | undefined {
  const parts = token.trim().split('.')
  if (parts.length !== 3 || parts[1].length % 4 === 1 || !/^[A-Za-z0-9_-]+={0,2}$/.test(parts[1])) return
  try {
    const encoded = parts[1] + (parts[1].length % 4 === 2 ? '==' : parts[1].length % 4 === 3 ? '=' : '')
    const bytes = Buffer.from(encoded, 'base64url'), canonical = bytes.toString('base64url')
    if (encoded !== canonical.padEnd(Math.ceil(canonical.length / 4) * 4, '=')) return 0
    const exp: unknown = JSON.parse(bytes.toString('utf8')).exp
    // CPA recognizes a positive fractional numeric exp before truncating it.
    // An unrepresentable positive value must never fall back to a later date.
    if (typeof exp === 'number' && exp > 0) return unix(exp) ?? 0
    if (typeof exp === 'string' && /^\s*\+?\d+\s*$/.test(exp) && Number(exp) > 0) return unix(exp) ?? 0
    return undefined
  } catch { return undefined }
}

/**
 * A same-call scheduling hint, never authority. Go still reads the current
 * record, checks its digest/epoch/use/quota, and revalidates every output chunk.
 * Match CPA 8289's AccessTokenExpirationTime: active JWT exp first, then SIWC
 * expires_at (when enabled), then the active credential's expired field.
 */
export function accessSnapshotReady(scope: CredentialScope, snapshot: NonNullable<WorkerConfiguration['accessSnapshot']>, now = Date.now()): boolean {
  if (!/^mikka-byos-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshot.name) || !snapshot.value || Buffer.byteLength(snapshot.value) > 32768) throw invalid()
  let bundle: unknown
  // error-cause: a JSON parse error quotes the projection, which may hold an access token.
  try { bundle = JSON.parse(snapshot.value) } catch { throw invalid() }
  if (!object(bundle) || bundle.schema !== 1 || bundle.ownerId !== scope.ownerId || bundle.workspaceId !== scope.workspaceId || bundle.connectionId !== scope.connectionId || bundle.provider !== scope.provider || !object(bundle.payload)) throw invalid()
  const payload = bundle.payload
  if (payload.type !== scope.provider || !text(payload.access_token) || typeof payload.expired !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(payload.expired) || date(payload.expired) === undefined || Object.hasOwn(payload, 'refresh_token') || Object.hasOwn(payload, 'id_token')) throw invalid()
  if (scope.provider === 'codex' ? !text(payload.account_id) : !text(payload.account_uuid) || !text(payload.organization_uuid)) throw invalid()
  if (payload.use_siwc !== undefined && typeof payload.use_siwc !== 'boolean') throw invalid()
  if (payload.siwc !== undefined && (!object(payload.siwc) || Object.hasOwn(payload.siwc, 'refresh_token') || Object.hasOwn(payload.siwc, 'id_token'))) throw invalid()
  const siwc = scope.provider === 'codex' && payload.use_siwc === true
  const active = siwc ? payload.siwc : payload
  if (!object(active) || !text(active.access_token)) throw invalid()
  const tokenExpiry = jwtExpiry(active.access_token)
  const explicitExpiry = siwc && Object.hasOwn(active, 'expires_at') ? date(active.expires_at) : undefined
  // A present but unsupported SIWC date is not evidence that a later buffered
  // date is safe. Keep malformed projections out of the custody fallback.
  if (tokenExpiry === undefined && siwc && Object.hasOwn(active, 'expires_at') && explicitExpiry === undefined) throw invalid()
  const expires = tokenExpiry ?? explicitExpiry ?? date(active.expired)
  if (expires === undefined || !Number.isFinite(now)) throw invalid()
  return expires > now + 60_000
}
