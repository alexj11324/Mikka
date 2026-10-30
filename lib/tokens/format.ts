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

export const hashPersonalAccessToken = (token: string) => createHash('sha256').update(token).digest('hex')

export function generatePersonalAccessToken(): { token: string; tokenHash: string; hint: string } {
  const token = `${PAT_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, tokenHash: hashPersonalAccessToken(token), hint: token.slice(-4) }
}

/** `expiresAt` is optional: null/absent means the token does not expire. */
export const createTokenInput = z.object({
  name: z.string().trim().min(1).max(PAT_NAME_MAX),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict()

export const revokeTokenInput = z.object({ id: z.uuid() }).strict()

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
