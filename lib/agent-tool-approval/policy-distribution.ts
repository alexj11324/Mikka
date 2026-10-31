import 'server-only'
import { createHash, createPrivateKey, createPublicKey, hkdfSync, sign } from 'node:crypto'
import { POLICY_SNAPSHOT_TTL_MS, policyDistributionContextSchema, policyIssuer, policySnapshotMessage, signedPolicySnapshotSchema, type PolicySnapshotPayload } from '@mikka/protocol/policy-snapshot'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import type { RunPolicy } from '@mikka/protocol/agent-policy'
import type { readCliRunPolicy } from './policy-store'

export function requestPolicyIssuer(request: Request) {
  const url = new URL(request.url), index = url.pathname.indexOf('/v1/')
  if (index < 0) throw Error('policyIssuerInvalid')
  return policyIssuer(`${url.origin}${url.pathname.slice(0,index)}`)
}
/** Domain-separated signing material from the existing server secret; never persisted or sent. */
function signingKey(issuer: string) {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret || Buffer.byteLength(secret) < 32) throw Error('policySigningUnavailable')
  const seed = hkdfSync('sha256',secret,'mikka-cli-policy-snapshot-v1',policyIssuer(issuer),32)
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(seed)]), format:'der',type:'pkcs8' })
  const publicKey = createPublicKey(privateKey).export({format:'der',type:'spki'})
  return {privateKey,publicKey:publicKey.toString('base64url'),keyId:createHash('sha256').update(publicKey).digest('hex')}
}
export function policyDistributionContext(issuer: string, ownerId: string, deviceId: string, runId: string, current: Pick<Awaited<ReturnType<typeof readCliRunPolicy>>, 'revision' | 'workspaceIds' | 'hierarchy' | 'policySnapshotRequired'>) {
  const key = signingKey(issuer)
  return policyDistributionContextSchema.parse({version:1,algorithm:'Ed25519',issuer:policyIssuer(issuer),ownerId,deviceId,runId,revision:current.revision,
    scope:{workspaceIds:current.workspaceIds,hierarchy:current.hierarchy ?? null},required:current.policySnapshotRequired === true,keyId:key.keyId,publicKey:key.publicKey})
}
export function issuePolicySnapshot(context: ReturnType<typeof policyDistributionContext>, policy: RunPolicy, now = Date.now()) {
  const payload: PolicySnapshotPayload = {version:1,issuer:context.issuer,ownerId:context.ownerId,deviceId:context.deviceId,runId:context.runId,revision:context.revision,policyHash:policySnapshotHash(policy),scope:context.scope,policy,issuedAt:now,expiresAt:now+POLICY_SNAPSHOT_TTL_MS}
  const key = signingKey(context.issuer)
  if (key.keyId !== context.keyId) throw Error('policySigningChanged')
  return signedPolicySnapshotSchema.parse({algorithm:'Ed25519',keyId:key.keyId,payload,signature:sign(null,policySnapshotMessage(payload),key.privateKey).toString('base64url')})
}
