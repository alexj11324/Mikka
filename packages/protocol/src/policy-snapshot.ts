import { z } from 'zod'
import { runPolicySchema } from './agent-policy'

export const POLICY_SNAPSHOT_HEADER = 'x-mikka-policy-snapshot'
export const POLICY_SNAPSHOT_VERSION = '1'
export const POLICY_SNAPSHOT_TTL_MS = 5 * 60_000
export const POLICY_SNAPSHOT_REFRESH_MS = 30_000
const id = z.string().min(1).max(128)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const policyScopeSchema = z.strictObject({
  workspaceIds: z.array(id).max(2),
  hierarchy: z.strictObject({ workspaceId: z.uuid(), teamId: z.uuid(), projectId: z.uuid().nullable() }).nullable(),
})
export const policySnapshotPayloadSchema = z.strictObject({
  version: z.literal(1), issuer: z.url().max(1000), ownerId: id, deviceId: id, runId: id,
  revision: digest, policyHash: digest, scope: policyScopeSchema, policy: runPolicySchema,
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
})
export const signedPolicySnapshotSchema = z.strictObject({
  algorithm: z.literal('Ed25519'), keyId: digest, payload: policySnapshotPayloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
})
export const policyDistributionContextSchema = z.strictObject({
  version: z.literal(1), algorithm: z.literal('Ed25519'), keyId: digest,
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{59}$/),
  issuer: z.url().max(1000), ownerId: id, deviceId: id, runId: id, revision: digest,
  scope: policyScopeSchema, required: z.boolean(),
})
export type PolicySnapshotPayload = z.infer<typeof policySnapshotPayloadSchema>
export type SignedPolicySnapshot = z.infer<typeof signedPolicySnapshotSchema>
export type PolicyDistributionContext = z.infer<typeof policyDistributionContextSchema>

/** The existing authenticated transport is the trust anchor, never a key inside a cached claim. */
export function policyIssuer(base: string): string {
  const url = new URL(base)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw Error('policyIssuerInvalid')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
export function policySnapshotMessage(payload: PolicySnapshotPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(policySnapshotPayloadSchema.parse(payload)))
}
