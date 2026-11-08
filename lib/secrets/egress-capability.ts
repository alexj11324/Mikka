// A sealed, short-lived third-party grant. Only the trusted application opens it;
// runners receive the opaque bearer, never the secret or the sealing key.
// Revocation is bounded by expiry, not instantaneous: a copied bearer can remain
// usable for at most 90 seconds. Renewal must re-check the persisted run lease.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { CodedError } from '@mikka/protocol/coded-error'
import { TASK_SECRET_MAX_TOKEN_BYTES, type TaskSecretGrant } from '@mikka/protocol/task-secrets'
import { z } from 'zod'
import { secretsKey } from './crypto'
import { secretHttpPolicy, type SecretHttpPolicy } from './delivery'

export const EGRESS_CAPABILITY_TTL_MS = 90_000
const PREFIX = 'mikka-egress-v1.'
const AAD = Buffer.from('mikka:task-secret-egress:capability:v1')
const KEY_DOMAIN = 'mikka:task-secret-egress:encryption-key:v1'
type Environment = Record<string, string | undefined>

export type EgressErrorDetail = 'invalid_capability' | 'expired_capability' | 'binding_mismatch'
  | 'invalid_request' | 'destination_denied' | 'upstream_unavailable' | 'response_blocked'
  | 'limit_exceeded' | 'configuration'

export const egressError = (detail: EgressErrorDetail, cause?: unknown) =>
  new CodedError('task_secret_unavailable', { detail, ...(cause === undefined ? {} : { cause }) })

export interface EgressCapabilityBinding {
  ownerId: string
  workspaceId: string | null
  repository: string | null
  runId: string
  deviceId: string
  deviceTokenId: string
  attempt: number
}

const identifierText = (value: string) => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
const identifier = z.string().min(1).max(256).refine(identifierText)
const claimsSchema = z.object({
  version: z.literal(1),
  ownerId: identifier,
  workspaceId: identifier.nullable(),
  repository: z.string().min(1).max(512).refine(identifierText).nullable(),
  runId: identifier,
  deviceId: identifier,
  deviceTokenId: identifier,
  attempt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  secretId: identifier.optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // This delivery supports a single HTTP authentication header. Multiline and
  // binary signing keys require a different, explicitly selected delivery mode.
  secret: z.string().min(1).max(32 * 1024).regex(/^[\x20-\x7e]+$/),
  http: secretHttpPolicy,
  issuedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()
export type EgressCapabilityClaims = z.infer<typeof claimsSchema>
export type ProtectedHttpConfig = SecretHttpPolicy

function key(env: Environment): Buffer {
  try { return createHmac('sha256', secretsKey(env)).update(KEY_DOMAIN).digest() }
  catch (cause) { throw egressError('configuration', cause) }
}

function checkedClaims(value: unknown): EgressCapabilityClaims {
  const parsed = claimsSchema.safeParse(value)
  if (!parsed.success) throw egressError('invalid_capability')
  const claims = parsed.data
  // The public grant descriptor caps origins at 512 characters. Refuse this
  // individual policy here so a malformed long host becomes unavailable rather
  // than invalidating the whole assignment after other grants were built.
  if (claims.http.origin.length > 512 || claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > EGRESS_CAPABILITY_TTL_MS)
    throw egressError('invalid_capability')
  return claims
}

/** Call only after authorizing this exact run, credential, attempt and effective
 * secret scope. This pure function cannot perform those database checks. */
export function issueEgressCapability(input: EgressCapabilityBinding & {
  name: string
  secretId?: string
  revision?: string
  secret: string
  http: SecretHttpPolicy
  leaseExpiresAt: Date | string | number
}, nowMs = Date.now(), env: Environment = process.env): TaskSecretGrant {
  const lease = input.leaseExpiresAt instanceof Date ? input.leaseExpiresAt.getTime()
    : typeof input.leaseExpiresAt === 'number' ? input.leaseExpiresAt : Date.parse(input.leaseExpiresAt)
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(lease) || lease <= nowMs)
    throw egressError('expired_capability')
  const { leaseExpiresAt: _lease, ...grant } = input
  const claims = checkedClaims({ ...grant, version: 1, issuedAt: nowMs, expiresAt: Math.min(lease, nowMs + EGRESS_CAPABILITY_TTL_MS) })
  const plaintext = Buffer.from(JSON.stringify(claims))
  // Bound before allocating/encrypting a token, and again after base64 framing.
  if (plaintext.length > 48 * 1024) throw egressError('limit_exceeded')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(env), nonce)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const capability = PREFIX + Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url')
  if (Buffer.byteLength(capability) > TASK_SECRET_MAX_TOKEN_BYTES) throw egressError('limit_exceeded')
  return { name: claims.name, capability, expiresAt: new Date(claims.expiresAt).toISOString(), origin: claims.http.origin }
}

/** No database or network work. `expected` comes from trusted route/run context,
 * never from fields alongside the capability in an Agent's request. A bearer
 * stolen from a task still authorizes its original scope until its expiry. */
export function openEgressCapability(capability: string, expected?: Partial<EgressCapabilityBinding>,
  nowMs = Date.now(), env: Environment = process.env): EgressCapabilityClaims {
  if (typeof capability !== 'string' || capability.length > TASK_SECRET_MAX_TOKEN_BYTES || !capability.startsWith(PREFIX))
    throw egressError('invalid_capability')
  const encoded = capability.slice(PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw egressError('invalid_capability')
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.length < 29 || bytes.toString('base64url') !== encoded) throw egressError('invalid_capability')
  const encryptionKey = key(env)
  let value: unknown
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12))
    decipher.setAAD(AAD)
    decipher.setAuthTag(bytes.subarray(-16))
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()])
    value = JSON.parse(plaintext.toString('utf8'))
  } catch (cause) { throw egressError('invalid_capability', cause) }
  const claims = checkedClaims(value)
  if (!Number.isSafeInteger(nowMs) || claims.issuedAt > nowMs || claims.expiresAt <= nowMs)
    throw egressError('expired_capability')
  if (expected) for (const field of Object.keys(expected) as Array<keyof EgressCapabilityBinding>) {
    if (expected[field] !== claims[field]) throw egressError('binding_mismatch')
  }
  return claims
}
