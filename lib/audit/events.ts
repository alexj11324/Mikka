// Pure audit-event contract: action catalogue, category mapping, validation.
// No DB or server-only imports so it can be shared with UI code and unit tests.
import { isIP } from 'node:net'
import { z } from 'zod'

export const AUDIT_CATEGORIES = ['security', 'secret', 'permission', 'member', 'billing'] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

export const AUDIT_ACTOR_TYPES = ['user', 'bot', 'token', 'system'] as const
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number]

/** Every auditable action and the category it is filed under (UI label + 「安全」 filter). */
export const AUDIT_ACTIONS = {
  // 成员（role_changed is a member event: design badge 「成员」）
  'member.invited': 'member',
  'member.invitation_revoked': 'member',
  'member.joined': 'member',
  'member.removed': 'member',
  'member.suspended': 'member',
  'member.reactivated': 'member',
  'member.role_changed': 'member',
  // 权限
  'team.access_changed': 'permission',
  'bot.permissions_changed': 'permission',
  'integration.permission_changed': 'permission',
  // 密钥与环境
  'secret.created': 'secret',
  'secret.replaced': 'secret',
  'secret.deleted': 'secret',
  'env.created': 'secret',
  'env.updated': 'secret',
  'env.deleted': 'secret',
  // 安全
  'token.created': 'security',
  'token.revoked': 'security',
  'auth.signed_in': 'security',
  'auth.sign_in_failed': 'security',
  'workspace.slug_changed': 'security',
  'workspace.deleted': 'security',
  'workspace.ownership_transferred': 'security',
  // 计费
  'billing.card_verified': 'billing',
  'billing.checkout_started': 'billing',
  'billing.credits_purchased': 'billing',
  'billing.auto_recharge_changed': 'billing',
  'billing.limits_changed': 'billing',
} as const satisfies Record<string, AuditCategory>

export type AuditAction = keyof typeof AUDIT_ACTIONS

// Per-action metadata allowlist. Every key an action may store is listed here
// (and nothing else is accepted), so UI ICU templates can use them as named
// params. Values are flat scalars.
const label = z.string().trim().min(1).max(120)
const role = z.enum(['owner', 'admin', 'member', 'guest'])
const access = z.enum(['allow', 'ask', 'deny', 'read', 'write', 'none'])
const scope = z.enum(['workspace', 'project', 'repo', 'bot', 'user'])
const cents = z.number().int().min(0).max(100_000_000)
const currency = z.string().regex(/^[A-Z]{3}$/)
const none = z.object({}).strict()
export const AUDIT_METADATA = {
  'member.invited': z.object({ role }).partial().strict(),
  'member.invitation_revoked': none,
  'member.joined': z.object({ role }).partial().strict(),
  'member.removed': none,
  'member.suspended': none,
  'member.reactivated': none,
  'member.role_changed': z.object({ oldRole: role, newRole: role }).strict(),
  'team.access_changed': z.object({ team: label, from: access, to: access }).partial().strict(),
  'bot.permissions_changed': z.object({ capability: label, from: access, to: access }).partial().strict(),
  'integration.permission_changed': z.object({ integration: label, capability: label, from: access, to: access }).strict(),
  'secret.created': z.object({ scope }).partial().strict(),
  'secret.replaced': z.object({ scope }).partial().strict(),
  'secret.deleted': z.object({ scope }).partial().strict(),
  'env.created': z.object({ scope }).partial().strict(),
  'env.updated': z.object({ scope }).partial().strict(),
  'env.deleted': z.object({ scope }).partial().strict(),
  'token.created': z.object({ tokenName: label, expiresAt: z.string().datetime({ offset: true }).nullable() }).partial().strict(),
  'token.revoked': none,
  'auth.signed_in': z.object({ newDevice: z.boolean(), method: z.enum(['password', 'oauth', 'magic_link', 'passkey', 'sso']) }).strict(),
  'auth.sign_in_failed': z.object({ method: z.enum(['password', 'oauth', 'magic_link', 'passkey', 'sso']), reason: z.enum(['invalid', 'locked', 'expired', 'denied']) }).partial().strict(),
  'workspace.slug_changed': z.object({ from: label, to: label }).strict(),
  'workspace.deleted': none,
  'workspace.ownership_transferred': none,
  'billing.card_verified': z.object({ allowanceGranted:z.boolean() }).strict(),
  'billing.checkout_started': z.object({ amountCents: cents, currency }).partial().strict(),
  'billing.credits_purchased': z.object({ amountCents: cents, currency, credits: z.number().int().min(0) }).partial().strict(),
  'billing.auto_recharge_changed': z.object({ enabled: z.boolean(), thresholdCents: cents.nullable(), amountCents: cents.nullable() }).partial().strict(),
  'billing.limits_changed': z.object({ fromCents: cents.nullable(), toCents: cents.nullable() }).partial().strict(),
} as const satisfies Record<AuditAction, z.ZodType>

/** Allowlisted metadata for one action (named params for that action's ICU template). */
export type AuditMetadata<A extends AuditAction> = z.infer<(typeof AUDIT_METADATA)[A]>
export type AuditMetadataMap = { [A in AuditAction]: AuditMetadata<A> }

export type AuditActor =
  | { type: 'user' | 'bot' | 'token'; id: string; name: string }
  | { type: 'system'; id?: string | null; name?: string }

/**
 * actor.name is a display snapshot taken at write time: the member's name for
 * users, the token's name for token actors, the bot's name for bots, "Mikka"
 * by default for system.
 */
export type AuditEvent<A extends AuditAction = AuditAction> = {
  workspaceId: string
  actor: AuditActor
  action: A
  target?: { type: string; id?: string | null; label?: string | null } | null
  /** Only the keys allowlisted for this action (AUDIT_METADATA); never secrets. */
  metadata?: AuditMetadata<A> | Record<string, unknown>
  ip?: string | null
  geoCity?: string | null
  geoCountry?: string | null
  geoRegion?: string | null
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
  geoCountry: string | null
  geoRegion: string | null
}

export class AuditEventError extends Error {
  constructor(message: string) { super(message); this.name = 'AuditEventError' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Credential shapes, matched anywhere in a string (e.g. "token=sk_live_…").
const NOT_WORD = '(?<![A-Za-z0-9])'
const SECRET_VALUE_PATTERNS: RegExp[] = [
  new RegExp(`${NOT_WORD}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`), // JWT, three segments
  new RegExp(`${NOT_WORD}[sr]k_(?:live_|test_)?[A-Za-z0-9]{16,}`), // Stripe
  new RegExp(`${NOT_WORD}sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}`), // OpenAI / Anthropic style
  new RegExp(`${NOT_WORD}(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`),
  new RegExp(`${NOT_WORD}github_pat_[A-Za-z0-9_]{20,}`),
  new RegExp(`${NOT_WORD}glpat-[A-Za-z0-9_-]{20,}`),
  new RegExp(`${NOT_WORD}xox[abposr]-[A-Za-z0-9-]{10,}`), // Slack
  new RegExp(`${NOT_WORD}xapp-[0-9]-[A-Za-z0-9-]{10,}`),
  new RegExp(`${NOT_WORD}whsec_[A-Za-z0-9+/=]{16,}`),
  new RegExp(`${NOT_WORD}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`), // AWS access key id
  new RegExp(`${NOT_WORD}AIza[0-9A-Za-z_-]{35}`), // Google API key
  new RegExp(`${NOT_WORD}npm_[A-Za-z0-9]{36}`),
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/, // PEM and PGP ("PRIVATE KEY BLOCK")
  /(?<![A-Za-z0-9])bearer\s+[A-Za-z0-9._~+/-]{16,}=*/i, // '_' counts as a boundary (id_Bearer …)
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // URL with user:password@
]

/** True when a string value contains something shaped like a credential. */
export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value)) || hasBasicCredentials(value)
}

// "Basic <base64(user:pass)>": only flagged when the token decodes to text with a ':'.
const BASIC_AUTH = /(?<![A-Za-z0-9])basic\s+([A-Za-z0-9+/]{6,}={0,2})(?![A-Za-z0-9+/=])/gi
function hasBasicCredentials(value: string): boolean {
  for (const match of value.matchAll(BASIC_AUTH)) {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8')
    if (/^[\x20-\x7e]+:[\x20-\x7e]*$/.test(decoded)) return true
  }
  return false
}

// Intentionally below the DB CHECK (8 KB): the JS cap fails fast with a clear
// error, and the DB limit is a backstop for any writer that bypasses toAuditRow.
const MAX_METADATA_BYTES = 4096

export const auditCategory = (action: AuditAction): AuditCategory => AUDIT_ACTIONS[action]

const clip = (value: string | null | undefined, max: number) => {
  const text = value?.replace(/\s+/g, ' ').trim()
  return text ? [...text].slice(0, max).join('') : null
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
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) throw new AuditEventError('audit metadata is too large')
  // The per-action .strict() schema is the gate: only listed keys, flat scalars.
  const allowed = AUDIT_METADATA[event.action].safeParse(metadata)
  if (!allowed.success) throw new AuditEventError(`audit metadata does not match the allowlist for ${event.action}: ${allowed.error.issues.map(issue => issue.code === 'unrecognized_keys' ? `unexpected ${issue.keys.join(',')}` : `${issue.path.join('.')} ${issue.code}`).join('; ')}`)
  for (const [key, value] of Object.entries(allowed.data as Record<string, unknown>))
    if (typeof value === 'string' && looksLikeSecretValue(value)) throw new AuditEventError(`audit metadata must not contain a secret-bearing value at metadata.${key}`)
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
    metadata: allowed.data as Record<string, unknown>,
    ip: ip && isIP(ip) ? ip : null,
    geoCity: clip(event.geoCity, 120),
    geoCountry: countryCode(event.geoCountry),
    geoRegion: regionCode(event.geoRegion),
  }
}

const countryCode = (value: string | null | undefined) => { const v = value?.trim().toUpperCase(); return v && /^[A-Z]{2}$/.test(v) ? v : null }
const regionCode = (value: string | null | undefined) => { const v = value?.trim().toUpperCase(); return v && /^[A-Z0-9]{1,3}$/.test(v) ? v : null }

/**
 * Client IP and Vercel geo (city in English as sent; ISO country; ISO 3166-2 region suffix).
 * Only trustworthy behind Vercel: its edge overwrites client-sent x-forwarded-for and
 * x-vercel-ip-* headers. Off Vercel (process.env.VERCEL !== '1') any client can forge
 * them, so ip AND geo are both null there rather than recording attacker-chosen values.
 * x-real-ip is deliberately not read.
 */
export function auditRequestContext(headers: Pick<Headers, 'get'>, env: Readonly<Record<string, string | undefined>> = process.env as Readonly<Record<string, string | undefined>>): { ip: string | null; geoCity: string | null; geoCountry: string | null; geoRegion: string | null } {
  if (env.VERCEL !== '1') return { ip: null, geoCity: null, geoCountry: null, geoRegion: null }
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  let city = headers.get('x-vercel-ip-city')
  if (city) { try { city = decodeURIComponent(city) } catch { /* keep raw */ } }
  return { ip: forwarded && isIP(forwarded) ? forwarded : null, geoCity: clip(city, 120), geoCountry: countryCode(headers.get('x-vercel-ip-country')), geoRegion: regionCode(headers.get('x-vercel-ip-country-region')) }
}
