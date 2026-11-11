// Personal access tokens: format, hashing and input rules. No database access here.
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

export const PAT_PREFIX = 'mkp_'
/** mkp_ + 32 random bytes in base64url (43 characters). */
export const PAT_SHAPE = /^mkp_[A-Za-z0-9_-]{43}$/
export const PAT_NAME_MAX = 64
/** Longest allowed lifetime when an expiry is set. */
export const PAT_MAX_LIFETIME_DAYS = 366
/** Active (unrevoked) tokens one person may hold in one workspace. */
export const PAT_ACTIVE_LIMIT = 50

/** The only scopes a new token may hold; each one names a `/api/v1` surface. */
export const API_SCOPES = ['tasks:read', 'tasks:write', 'runs:read', 'runs:write'] as const
export type ApiScope = typeof API_SCOPES[number]
/** Internal scope on tokens created before M4. Never selectable in the UI or API. */
export const LEGACY_SCOPE = 'legacy:full' as const
export const TOKEN_SCOPES = [...API_SCOPES, LEGACY_SCOPE] as const
export type TokenScope = typeof TOKEN_SCOPES[number]
export const DEFAULT_API_SCOPES: readonly ApiScope[] = API_SCOPES
export const READ_ONLY_API_SCOPES: readonly ApiScope[] = ['tasks:read', 'runs:read']

/** `/api/v1` public API audience, distinct from the device daemon's `/v1` namespace.
 * A token is either legacy-only or public-scope-only; the migration enforces the split. */
export type ApiAudience = 'legacy' | 'v1'

export const isApiScope = (value: unknown): value is ApiScope => (API_SCOPES as readonly unknown[]).includes(value)
export const isLegacyToken = (scopes: readonly string[]) => scopes.includes(LEGACY_SCOPE)
export const publicTokenScopes = (scopes: readonly string[]): ApiScope[] => scopes.filter(isApiScope)

/** Legacy tokens only reach the pre-M4 routes; public-scope tokens only reach `/api/v1`. */
export function audienceAllows(scopes: readonly string[], audience: ApiAudience): boolean {
  const legacy = isLegacyToken(scopes)
  return audience === 'legacy' ? legacy : !legacy && scopes.some(isApiScope)
}

/** Whether a token carries every scope a route requires. */
export function hasApiScope(scopes: readonly string[], required: ApiScope | readonly ApiScope[]): boolean {
  const requiredScopes = typeof required === 'string' ? [required] : required
  return requiredScopes.every(scope => scopes.includes(scope))
}

export const hashPersonalAccessToken = (token: string) => createHash('sha256').update(token).digest('hex')

export function generatePersonalAccessToken(): { token: string; tokenHash: string; hint: string } {
  const token = `${PAT_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, tokenHash: hashPersonalAccessToken(token), hint: token.slice(-4) }
}

/** Public scopes a new token may request; legacy:full is never accepted here. */
export const apiScopesSchema = z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length)
  .refine(scopes => new Set(scopes).size === scopes.length, 'duplicate scope')

/** `expiresAt` is optional: null/absent means the token does not expire.
 * `scopes` absent defaults to the full public set; legacy:full is never
 * accepted from a caller. */
export const createTokenInput = z.object({
  name: z.string().trim().min(1).max(PAT_NAME_MAX),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  scopes: apiScopesSchema.optional(),
}).strict()

/** Name/expiry only: the legacy test/backfill helper chooses `legacy:full` itself. */
export const legacyTokenInput = createTokenInput.omit({ scopes: true })

export const revokeTokenInput = z.object({ id: z.uuid() }).strict()
export const rotateTokenInput = z.object({ id: z.uuid() }).strict()

/** Null for no expiry; throws 'past' or 'tooFar' for an unusable date. */
export function checkExpiry(expiresAt: string | null | undefined, now: Date): Date | null {
  if (!expiresAt) return null
  const at = new Date(expiresAt)
  if (at.getTime() <= now.getTime()) throw new RangeError('past')
  if (at.getTime() - now.getTime() > PAT_MAX_LIFETIME_DAYS * 86_400_000) throw new RangeError('tooFar')
  return at
}

/** The bearer token in an Authorization header, when it has our shape. The scheme is case-insensitive (RFC 7235). */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(header?.trim() ?? '')
  return match && PAT_SHAPE.test(match[1]) ? match[1] : null
}
