import { createHmac, timingSafeEqual } from 'node:crypto'

/** Checks GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body). */
export function verifyGitHubSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`)
  const actual = Buffer.from(header)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
