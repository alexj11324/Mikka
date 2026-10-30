// AES-256-GCM sealing for workspace secrets and E2B keys under WORKSPACE_SECRETS_KEY.
// Fails closed: with no (or a malformed) key nothing is encrypted or decrypted.
// The key is 32 bytes as 64 hex chars or base64/base64url. It is NOT configured in
// any Vercel or Infisical environment yet (needs Alex's OK); tests use a random
// per-run key. Associated data binds a ciphertext to its row (workspace, kind,
// scope, name), so a ciphertext copied onto another row will not decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const SECRETS_KEY_VERSION = 1

export class SecretsKeyMissingError extends Error {
  constructor() { super('Workspace secrets encryption is not configured'); this.name = 'SecretsKeyMissingError' }
}

export function secretsKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.WORKSPACE_SECRETS_KEY?.trim() ?? ''
  let key: Buffer | null = null
  if (/^[a-f\d]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex')
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(raw)) key = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (!key || key.length !== 32) throw new SecretsKeyMissingError()
  return key
}

export interface Sealed { ciphertext: string; iv: string; keyVersion: number }

export function sealSecret(plaintext: string, aad: string, env?: Record<string, string | undefined>): Sealed {
  const key = secretsKey(env)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { ciphertext: body.toString('base64'), iv: iv.toString('base64'), keyVersion: SECRETS_KEY_VERSION }
}

export function openSecret(sealed: Sealed, aad: string, env?: Record<string, string | undefined>): string {
  if (sealed.keyVersion !== SECRETS_KEY_VERSION) throw new Error(`Unsupported secrets key version ${sealed.keyVersion}`)
  const key = secretsKey(env)
  const body = Buffer.from(sealed.ciphertext, 'base64')
  if (body.length < 16) throw new Error('Stored secret is invalid')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(body.subarray(body.length - 16))
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8')
}

export const secretAad = (row: { workspaceId: string; kind: string; scopeType: string; scopeRef: string; name: string }) =>
  ['workspace_secret', row.workspaceId.toLowerCase(), row.kind, row.scopeType, row.scopeRef, row.name].join('\u0000')
export const e2bKeyAad = (workspaceId: string) => ['workspace_e2b_key', workspaceId.toLowerCase()].join('\u0000')
