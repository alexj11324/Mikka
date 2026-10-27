import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AwsClient } from 'aws4fetch'
import { getVercelOidcToken } from '@vercel/oidc'
import { CredentialError, type EncryptionContext, type Envelope } from './contracts'

export type Kms = { generate(context: EncryptionContext): Promise<{ plaintext: Buffer; wrapped: string }>; decrypt(wrapped: string, context: EncryptionContext): Promise<Buffer> }
const aad = (context: EncryptionContext, kind = 'password') => Buffer.from(JSON.stringify({ userId: context.userId, credentialId: context.credentialId, origin: context.origin, v: 1, kind }))

/** No fallback to AWS access keys, instance profiles, or another project's role. */
export async function assumeVercelRole(role: 'app' | 'broker') {
  const arn = process.env[role === 'app' ? 'CREDENTIAL_APP_ROLE_ARN' : 'CREDENTIAL_BROKER_ROLE_ARN']
  if (!arn || !/^arn:aws:iam::\d{12}:role\//.test(arn)) throw new CredentialError()
  try {
    const response = await fetch('https://sts.amazonaws.com/', {
      method: 'POST', body: new URLSearchParams({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: arn,
        RoleSessionName: `mikka-credential-${role}`, DurationSeconds: '900', WebIdentityToken: await getVercelOidcToken() }),
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

export async function seal(kms: Kms, context: EncryptionContext, plaintext: Buffer): Promise<Envelope> {
  let key: Buffer | undefined
  try {
    const generated = await kms.generate(context)
    key = generated.plaintext
    const wrapped = generated.wrapped
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad(context))
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    return { v: 1, wrappedDek: wrapped, nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64') }
  } finally { key?.fill(0); plaintext.fill(0) }
}

/** Import only in the isolated broker deployment. Main app never calls decrypt. */
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
  const key = await kms.decrypt(wrappedDek, context)
  try {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad(context, 'session'))
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    return { v: 1, wrappedDek, nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64') }
  } finally { key.fill(0); plaintext.fill(0) }
}
