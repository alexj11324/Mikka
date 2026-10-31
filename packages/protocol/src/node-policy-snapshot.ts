/// <reference types="node" />
// Node consumers only. The normal device/schema entry points contain no Node crypto.
import { Buffer } from 'node:buffer'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { runPolicySchema, runPolicyDigestInput, type RunPolicy } from './agent-policy'
import { POLICY_SNAPSHOT_TTL_MS, policyDistributionContextSchema, policyIssuer, policySnapshotMessage, signedPolicySnapshotSchema, type PolicyDistributionContext, type SignedPolicySnapshot } from './policy-snapshot'

export const policySnapshotHash = (policy: RunPolicy) => createHash('sha256').update(runPolicyDigestInput(policy)).digest('hex')

export function verifyPolicySnapshot(value: unknown, trusted: PolicyDistributionContext, expected: {
  runId: string; deviceId: string; revision: string; policy?: RunPolicy
}, options: { now?: number; allowExpired?: boolean } = {}): SignedPolicySnapshot {
  const context = policyDistributionContextSchema.parse(trusted)
  const snapshot = signedPolicySnapshotSchema.parse(value), p = snapshot.payload, now = options.now ?? Date.now()
  if (policyIssuer(context.issuer) !== context.issuer || policyIssuer(p.issuer) !== context.issuer || p.ownerId !== context.ownerId || p.deviceId !== context.deviceId || p.runId !== context.runId || p.revision !== context.revision ||
    p.policyHash !== policySnapshotHash(p.policy) || p.runId !== expected.runId || p.deviceId !== expected.deviceId || p.revision !== expected.revision || snapshot.keyId !== context.keyId || JSON.stringify(p.scope) !== JSON.stringify(context.scope) ||
    (expected.policy && JSON.stringify(p.policy) !== JSON.stringify(runPolicySchema.parse(expected.policy)))) throw Error('policySnapshotBindingInvalid')
  if (p.issuedAt > now + 30_000 || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > POLICY_SNAPSHOT_TTL_MS || (!options.allowExpired && p.expiresAt <= now)) throw Error('policySnapshotExpired')
  const der = Buffer.from(context.publicKey, 'base64url')
  if (createHash('sha256').update(der).digest('hex') !== context.keyId || !verify(null, policySnapshotMessage(p), createPublicKey({ key: der, type: 'spki', format: 'der' }), Buffer.from(snapshot.signature, 'base64url'))) throw Error('policySnapshotSignatureInvalid')
  return snapshot
}
