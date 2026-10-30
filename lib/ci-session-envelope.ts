import 'server-only'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/** All fields are server-derived and identify the only run allowed to restore
 * this snapshot. The serialized scope is authenticated, never trusted from the
 * encrypted payload itself. */
export type CiSessionScope = {
  ownerId: string; workspaceId: string; consumerId: string; bindingId: string
  accountId: string; route: string; revision: number; modelId: string
  runId: string; sessionId: string
}

const MAX_BYTES = 8 * 1024 * 1024
const aad = (s: CiSessionScope) => Buffer.from(JSON.stringify([
  'mikka-ci-session-v1', s.ownerId, s.workspaceId, s.consumerId, s.bindingId,
  s.accountId, s.route, s.revision, s.modelId, s.runId, s.sessionId,
]))
const key = (secret: string) => {
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('CI session encryption unavailable')
  return Buffer.from(hkdfSync('sha256', secret, 'mikka-ci-session-v1', 'snapshot', 32))
}

/** Store only ciphertext; callers must supply a server-derived scope. */
export function sealCiSession(scope: CiSessionScope, bytes: Buffer, secret: string): Buffer {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('CI session snapshot unavailable')
  const k = key(secret)
  try {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', k, nonce)
    cipher.setAAD(aad(scope))
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
  } finally { k.fill(0) }
}

export function openCiSession(scope: CiSessionScope, envelope: Buffer, secret: string): Buffer {
  if (envelope.length <= 29 || envelope.length > MAX_BYTES + 29 || envelope[0] !== 1) throw new Error('CI session snapshot unavailable')
  const k = key(secret)
  try {
    const cipher = createDecipheriv('aes-256-gcm', k, envelope.subarray(1, 13))
    cipher.setAAD(aad(scope))
    cipher.setAuthTag(envelope.subarray(13, 29))
    return Buffer.concat([cipher.update(envelope.subarray(29)), cipher.final()])
  } catch { throw new Error('CI session snapshot unavailable') } finally { k.fill(0) }
}
