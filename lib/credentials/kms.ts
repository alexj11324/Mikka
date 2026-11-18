import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AwsClient } from 'aws4fetch'
import { getVercelOidcToken } from '@vercel/oidc'
import { CredentialError, type EncryptionContext, type Envelope } from './contracts'
import { isCloudEdition } from '@/lib/edition'
import { cloudflareCredentialToken, credentialRuntimeEnvironment } from './runtime-identity'

export type Kms = { generate(context: EncryptionContext): Promise<{ plaintext: Buffer; wrapped: string }>; decrypt(wrapped: string, context: EncryptionContext): Promise<Buffer> }
const aad = (context: EncryptionContext, kind = 'password') => Buffer.from(JSON.stringify({ userId: context.userId, credentialId: context.credentialId, origin: context.origin, v: 1, kind }))

/** Community vaults keep the existing per-secret DEK and authenticated context.
 * Only the DEK is wrapped by the administrator's local master key. */
export function localKms(role: 'app' | 'broker', env: Record<string, string | undefined> = process.env): Kms {
  function master() {
    const raw = env.CREDENTIAL_MASTER_KEY ?? ''
    const key = Buffer.from(raw, 'base64')
    if (key.length !== 32 || key.toString('base64') !== raw) { key.fill(0); throw new CredentialError() }
    return key
  }
  return {
    async generate(context) {
      if (role !== 'app') throw new CredentialError()
      const key = master(), plaintext = randomBytes(32)
      try {
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
        cipher.setAAD(aad(context, 'dek'))
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
        return { plaintext, wrapped: `local:v1:${Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64')}` }
      // error-cause: local key wrapping has the same opaque secret boundary as AWS KMS; never retain cryptographic inputs in causes.
      } catch { plaintext.fill(0); throw new CredentialError() } finally { key.fill(0) }
    },
    async decrypt(wrapped, context) {
      if (role !== 'broker') throw new CredentialError()
      const key = master()
      try {
        if (!wrapped.startsWith('local:v1:')) throw new Error()
        const encoded = wrapped.slice('local:v1:'.length), data = Buffer.from(encoded, 'base64')
        if (data.length !== 60 || data.toString('base64') !== encoded) throw new Error()
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
        decipher.setAAD(aad(context, 'dek')); decipher.setAuthTag(data.subarray(-16))
        return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()])
      // error-cause: ciphertext, owner context and master-key failures must be indistinguishable outside the credential boundary.
      } catch { throw new CredentialError() } finally { key.fill(0) }
    },
  }
}

/** Resolve at use time; a cloud deployment never falls back to a local key. */
export function credentialKms(role: 'app' | 'broker'): Kms {
  const backend = () => isCloudEdition() ? awsKms(role) : localKms(role)
  return { generate: context => backend().generate(context), decrypt: (wrapped, context) => backend().decrypt(wrapped, context) }
}

/** Each platform uses its own runtime issuer; no fallback to another identity. */
export async function assumeVercelRole(role: 'app' | 'broker') {
  const arn = process.env[role === 'app' ? 'CREDENTIAL_APP_ROLE_ARN' : 'CREDENTIAL_BROKER_ROLE_ARN']
  if (!arn || !/^arn:aws:iam::\d{12}:role\//.test(arn)) throw new CredentialError()
  try {
    const token = credentialRuntimeEnvironment() ? await cloudflareCredentialToken() : await getVercelOidcToken()
    const response = await fetch('https://sts.amazonaws.com/', {
      method: 'POST', body: new URLSearchParams({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: arn,
        RoleSessionName: `mikka-credential-${role}`, DurationSeconds: '900', WebIdentityToken: token }),
      signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store',
    })
    const xml = await response.text()
    if (!response.ok) throw new Error()
    const field = (name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1]
    const accessKeyId = field('AccessKeyId'), secretAccessKey = field('SecretAccessKey'), sessionToken = field('SessionToken')
    if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error()
    return new AwsClient({ accessKeyId, secretAccessKey, sessionToken, region: process.env.AWS_REGION ?? 'us-east-1', service: 'kms', retries: 0 })
  } catch { throw new CredentialError() }
}

export function awsKms(role: 'app' | 'broker'): Kms {
  async function call(action: string, input: Record<string, unknown>) {
    try {
      const region = process.env.AWS_REGION ?? 'us-east-1'
      if (!/^[a-z]{2}-[a-z]+-\d$/.test(region) || !process.env.CREDENTIAL_KMS_KEY_ARN) throw new Error()
      const client = await assumeVercelRole(role)
      const response = await client.fetch(`https://kms.${region}.amazonaws.com/`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `TrentService.${action}` },
        body: JSON.stringify({ KeyId: process.env.CREDENTIAL_KMS_KEY_ARN, ...input }), signal: AbortSignal.timeout(10_000), redirect: 'error',
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error() }
      return await response.json()
    } catch { throw new CredentialError() } // Provider bodies, stack causes and credentials never leave this boundary.
  }
  return {
    async generate(context) {
      if (role !== 'app') throw new CredentialError()
      const data = await call('GenerateDataKey', { KeySpec: 'AES_256', EncryptionContext: context })
      const plaintext = Buffer.from(data.Plaintext ?? '', 'base64')
      if (plaintext.length !== 32 || typeof data.CiphertextBlob !== 'string') { plaintext.fill(0); throw new CredentialError() }
      return { plaintext, wrapped: data.CiphertextBlob }
    },
    async decrypt(wrapped, context) {
      if (role !== 'broker') throw new CredentialError()
      const data = await call('Decrypt', { CiphertextBlob: wrapped, EncryptionContext: context })
      const key = Buffer.from(data.Plaintext ?? '', 'base64')
      if (key.length !== 32) { key.fill(0); throw new CredentialError() }
      return key
    },
  }
}

export async function seal(kms: Kms, context: EncryptionContext, plaintext: Buffer, kind = 'password'): Promise<Envelope> {
  let key: Buffer | undefined
  try {
    const generated = await kms.generate(context)
    key = generated.plaintext
    const wrapped = generated.wrapped
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad(context, kind))
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    return { v: 1, wrappedDek: wrapped, nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64') }
  } finally { key?.fill(0); plaintext.fill(0) }
}

/** Called by the isolated cloud broker or the in-process community broker. */
export async function open(kms: Kms, context: EncryptionContext, envelope: Envelope, kind = 'password'): Promise<Buffer> {
  const key = await kms.decrypt(envelope.wrappedDek, context)
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64'), data = Buffer.from(envelope.ciphertext, 'base64')
    if (envelope.v !== 1 || nonce.length !== 12 || data.length < 16) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad(context, kind)); decipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()])
  } catch { throw new CredentialError() } finally { key.fill(0) }
}

/** Session snapshots use the credential's wrapped DEK with a fresh GCM nonce and
 * distinct AAD purpose. The decrypt-only broker cannot call GenerateDataKey. */
export async function sealSession(kms: Kms, context: EncryptionContext, wrappedDek: string, plaintext: Buffer): Promise<Envelope> {
  let key: Buffer | undefined
  try {
    key = await kms.decrypt(wrappedDek, context)
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad(context, 'session'))
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    return { v: 1, wrappedDek, nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64') }
  } finally { key?.fill(0); plaintext.fill(0) }
}
