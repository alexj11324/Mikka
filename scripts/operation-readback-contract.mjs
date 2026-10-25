import { createHash } from 'node:crypto'

/** Validate independent readback against private expected identity, not two
 * possibly incomplete responses. The key encoding matches the ledger v1 contract.
 */
export function verifyOperationReadback(manifest, operation, remote) {
  const expectedKey = createHash('sha256').update(JSON.stringify(['mikka-operation-v1', manifest.ownerId, manifest.workspaceId, manifest.operationId])).digest('hex')
  if (operation?.operationId !== manifest.operationId || operation?.ownerId !== manifest.ownerId || operation?.workspaceId !== manifest.workspaceId || operation?.status !== 'succeeded' || operation?.receipt?.providerObjectId !== manifest.providerObjectId || operation?.idempotencyKey !== expectedKey) throw new Error('operation binding or result mismatch')
  if (remote?.source !== 'provider' || remote?.providerObjectId !== manifest.providerObjectId || remote?.idempotencyKey !== expectedKey) throw new Error('independent provider readback mismatch')
}
