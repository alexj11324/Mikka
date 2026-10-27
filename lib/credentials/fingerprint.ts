import { createHmac, timingSafeEqual } from 'node:crypto'
import { CredentialError } from './contracts.js'

export type SecretFingerprint = { digest: string; length: number }
export function fingerprint(userId: string, value: string, authSecret = process.env.BETTER_AUTH_SECRET): SecretFingerprint {
  if (!authSecret) throw new CredentialError()
  const key = createHmac('sha256', authSecret).update('mikka-credential-leak-v1').digest()
  try { return { digest: createHmac('sha256', key).update(userId).update('\0').update(value).digest('hex'), length: value.length } }
  finally { key.fill(0) }
}
/** Scan strings before writing chat/tool data. No original value or matching
 * substring is ever returned or included in an exception. */
export function assertNoSecret(userId: string, value: unknown, entries: SecretFingerprint[], authSecret = process.env.BETTER_AUTH_SECRET) {
  const strings: string[] = []
  function walk(item: unknown) {
    if (typeof item === 'string') strings.push(item)
    else if (Array.isArray(item)) item.forEach(walk)
    else if (item && typeof item === 'object') Object.values(item).forEach(walk)
  }
  walk(value)
  const lengths = [...new Set(entries.map(entry => entry.length))]
  for (const text of strings) for (const length of lengths) for (let i = 0; i + length <= text.length; i++) {
    const actual = Buffer.from(fingerprint(userId, text.slice(i, i + length), authSecret).digest, 'hex')
    if (entries.some(entry => entry.length === length && timingSafeEqual(actual, Buffer.from(entry.digest, 'hex')))) throw new CredentialError('credential_secret_detected', 400)
  }
}
