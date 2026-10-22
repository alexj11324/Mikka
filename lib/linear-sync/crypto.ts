import 'server-only'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

function encryptionKey() {
  const value = process.env.LINEAR_TOKEN_ENCRYPTION_KEY ?? ''
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error('Linear token encryption is not configured')
  return Buffer.from(value, 'hex')
}

export function hashValue(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function seal(value: string) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function unseal(value: string) {
  const [version, encodedNonce, encodedTag, encodedCiphertext, ...extra] = value.split('.')
  if (version !== 'v1' || !encodedNonce || !encodedTag || !encodedCiphertext || extra.length) throw new Error('Stored Linear credential is invalid')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encodedNonce, 'base64url'))
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString('utf8')
}
