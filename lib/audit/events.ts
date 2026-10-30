// Pure audit-event contract: action catalogue, category mapping, validation.
// No DB or server-only imports so it can be shared with UI code and unit tests.
import { isIP } from 'node:net'

export const AUDIT_CATEGORIES = ['security', 'secret', 'permission', 'member', 'billing'] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

export const AUDIT_ACTOR_TYPES = ['user', 'bot', 'token', 'system'] as const
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number]

/** Every auditable action and the category it is filed under (UI label + 「安全」 filter). */
export const AUDIT_ACTIONS = {
  // 成员
  'member.invited': 'member',
  'member.invitation_revoked': 'member',
  'member.joined': 'member',
  'member.removed': 'member',
  'member.suspended': 'member',
  'member.reactivated': 'member',
  // 权限
  'member.role_changed': 'permission',
  'team.access_changed': 'permission',
  'bot.permissions_changed': 'permission',
  // 密钥与环境
  'secret.created': 'secret',
  'secret.replaced': 'secret',
  'secret.deleted': 'secret',
  'env.created': 'secret',
  'env.updated': 'secret',
  'env.deleted': 'secret',
  // 安全
  'network_policy.updated': 'security',
  'token.created': 'security',
  'token.revoked': 'security',
  'auth.signed_in': 'security',
  'auth.sign_in_failed': 'security',
  'workspace.slug_changed': 'security',
  'workspace.deleted': 'security',
  // 计费
  'billing.checkout_started': 'billing',
  'billing.credits_purchased': 'billing',
  'billing.auto_recharge_changed': 'billing',
  'billing.limits_changed': 'billing',
} as const satisfies Record<string, AuditCategory>

export type AuditAction = keyof typeof AUDIT_ACTIONS

export type AuditActor =
  | { type: 'user' | 'bot' | 'token'; id: string; name: string }
  | { type: 'system'; id?: string | null; name?: string }

export type AuditEvent = {
  workspaceId: string
  actor: AuditActor
  action: AuditAction
  target?: { type: string; id?: string | null; label?: string | null } | null
  /** Non-secret context only. Keys that look like secret values are rejected. */
  metadata?: Record<string, unknown>
  ip?: string | null
  geoCity?: string | null
}

export type AuditRow = {
  workspaceId: string
  actorType: AuditActorType
  actorId: string | null
  actorName: string
  action: AuditAction
  category: AuditCategory
  targetType: string | null
  targetId: string | null
  targetLabel: string | null
  metadata: Record<string, unknown>
  ip: string | null
  geoCity: string | null
}

export class AuditEventError extends Error {
  constructor(message: string) { super(message); this.name = 'AuditEventError' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Lower-cased, separator-free key names that must never carry a value into the audit log.
// Key names are normalised (separators stripped, lowercased) and then matched:
// exact words, substrings, a `key` suffix, and auth-style names. `author` and
// similar stay allowed. Values are also scanned for well-known credential prefixes.
const FORBIDDEN_KEY_EXACT = new Set(['value', 'plaintext', 'cardnumber', 'pan', 'cvc', 'cvv'])
const FORBIDDEN_KEY_PARTS = ['token', 'secret', 'passw', 'pwd', 'apikey', 'credential', 'jwt', 'bearer', 'cookie', 'dsn', 'connectionstring', 'privatekey', 'accesskey', 'otp']
// 'auth' only as authorization / auth header-token style names, never 'author…'.
const FORBIDDEN_AUTH = /authoriz|auth(?:header|code|z)?$/
const SECRET_VALUE_PREFIXES = ['sk_', 'rk_', 'ghp_', 'gho_', 'github_pat_', 'xox', 'eyj', '-----begin', 'whsec_']

export const normaliseAuditKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')

/** True when a metadata key name could carry a secret. */
export function isSecretBearingKey(key: string): boolean {
  const k = normaliseAuditKey(key)
  if (!k) return false
  if (FORBIDDEN_KEY_EXACT.has(k) || k.endsWith('key')) return true
  if (FORBIDDEN_KEY_PARTS.some(part => k.includes(part))) return true
  return FORBIDDEN_AUTH.test(k)
}

/** True when a string value looks like a credential (case-insensitive prefix, after trimming). */
export function looksLikeSecretValue(value: string): boolean {
  const v = value.trimStart().toLowerCase()
  return SECRET_VALUE_PREFIXES.some(prefix => v.startsWith(prefix))
}

// Intentionally below the DB CHECK (8 KB): the JS cap fails fast with a clear
// error, and the DB limit is a backstop for any writer that bypasses toAuditRow.
const MAX_METADATA_BYTES = 4096

export const auditCategory = (action: AuditAction): AuditCategory => AUDIT_ACTIONS[action]

const clip = (value: string | null | undefined, max: number) => {
  const text = value?.replace(/\s+/g, ' ').trim()
  return text ? [...text].slice(0, max).join('') : null
}

function assertNoSecrets(value: unknown, path: string) {
  if (typeof value === 'string') { if (looksLikeSecretValue(value)) throw new AuditEventError(`audit metadata must not contain a secret-bearing value at ${path}`); return }
  if (Array.isArray(value)) { value.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`)); return }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (isSecretBearingKey(key)) throw new AuditEventError(`audit metadata must not contain secret-bearing key ${path}.${key}`)
      assertNoSecrets(inner, `${path}.${key}`)
    }
  }
}

/** Validates an event and turns it into the exact row to insert. Throws AuditEventError. */
export function toAuditRow(event: AuditEvent): AuditRow {
  if (!UUID.test(event.workspaceId ?? '')) throw new AuditEventError('audit workspaceId must be a uuid')
  if (!Object.hasOwn(AUDIT_ACTIONS, event.action)) throw new AuditEventError(`unknown audit action ${String(event.action)}`)
  const actor = event.actor
  if (!actor || !(AUDIT_ACTOR_TYPES as readonly string[]).includes(actor.type)) throw new AuditEventError('audit actor type is invalid')
  const actorId = clip(actor.id, 200)
  if (actor.type !== 'system' && !actorId) throw new AuditEventError('audit actor id is required')
  const actorName = clip(actor.name, 200) ?? (actor.type === 'system' ? 'Mikka' : null)
  if (!actorName) throw new AuditEventError('audit actorName is required (snapshot it at write time)')
  const target = event.target ?? null
  const targetType = clip(target?.type, 40)
  if (target && !targetType) throw new AuditEventError('audit target type is required')
  const metadata = event.metadata ?? {}
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new AuditEventError('audit metadata must be an object')
  assertNoSecrets(metadata, 'metadata')
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) throw new AuditEventError('audit metadata is too large')
  const ip = clip(event.ip, 64)
  return {
    workspaceId: event.workspaceId.toLowerCase(),
    actorType: actor.type,
    actorId,
    actorName,
    action: event.action,
    category: auditCategory(event.action),
    targetType,
    targetId: target ? clip(target.id, 200) : null,
    // actorName/targetLabel are display snapshots and are NOT scanned: callers
    // must never put a secret value in targetLabel (use the secret's name).
    targetLabel: target ? clip(target.label, 200) : null,
    metadata,
    ip: ip && isIP(ip) ? ip : null,
    geoCity: clip(event.geoCity, 120),
  }
}

/** Client IP and Vercel city (English, as sent; localise on display) from request headers. */
export function auditRequestContext(headers: Pick<Headers, 'get'>): { ip: string | null; geoCity: string | null } {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || null
  let city = headers.get('x-vercel-ip-city')
  if (city) { try { city = decodeURIComponent(city) } catch { /* keep raw */ } }
  return { ip: forwarded && isIP(forwarded) ? forwarded : null, geoCity: clip(city, 120) }
}
