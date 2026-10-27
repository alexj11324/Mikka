import { z } from 'zod'

export class CredentialError extends Error {
  constructor(public code = 'credential_unavailable', public status = 503) { super(code) }
}
export const secretText = z.string().min(1).max(4096).refine(value => !/[\r\n\0]/.test(value))
export const submitSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  origin: z.string().max(2048), username: secretText, password: secretText,
}).strict()
export type Actor = { userId: string; workspaceId: string }
export type BrowserCaller = Actor & { botId: string; subagentId?: string; runId?: string }
export type EncryptionContext = { userId: string; credentialId: string; origin: string }
export type Envelope = { v: 1; wrappedDek: string; nonce: string; ciphertext: string }

/** Browsing stays unrestricted. Only secret insertion requires this exact origin. */
export function canonicalOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname.endsWith('.') || !url.hostname) throw new Error()
    // URL applies IDNA/punycode; confusable Unicode domains remain a different origin.
    return url.origin
  } catch { throw new CredentialError('credential_origin_invalid', 400) }
}
export function assertSameOrigin(actual: string, expected: string) {
  if (canonicalOrigin(actual) !== canonicalOrigin(expected)) throw new CredentialError('credential_denied', 404)
}
