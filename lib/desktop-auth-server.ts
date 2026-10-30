import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** base64url(sha256(verifier)), as in RFC 7636 S256. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function verifierMatches(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(challengeFor(verifier))
  const expected = Buffer.from(challenge)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function newExchangeCode(): string {
  return randomBytes(32).toString('base64url')
}
