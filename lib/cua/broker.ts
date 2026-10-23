import type { ComputerOperation, DesktopConfig } from './operation'
import { desktopFingerprint, normalizedOperation } from './operation'

export type ComputerRequest = { id: string; userId: string; sessionId: string; workspaceId: string; target: string; operation: ComputerOperation; status: string; expiresAt: Date }
export interface ComputerRequestStore {
  pending(userId: string, sessionId: string): Promise<ComputerRequest[]>
  insert(request: ComputerRequest): Promise<void>
  // Atomic conditional update; a consumed, denied, expired or differently
  // scoped request can never be admitted a second time.
  consume(id: string, userId: string, sessionId: string, target: string, now: Date, status: 'executing' | 'denied'): Promise<ComputerRequest | null>
  finish(id: string, status: 'complete' | 'failed'): Promise<void>
}
export async function prepareComputerRequest(store: ComputerRequestStore, userId: string, sessionId: string, config: DesktopConfig, value: unknown, now = new Date()) {
  const operation = normalizedOperation(value)
  const request: ComputerRequest = { id: crypto.randomUUID(), userId, sessionId, target: desktopFingerprint(config), workspaceId: config.workspaceId, operation, status: 'pending', expiresAt: new Date(now.getTime() + 5 * 60000) }
  await store.insert(request)
  return { approvalRequired: true, requestId: request.id, operation, expiresAt: request.expiresAt.toISOString() }
}
export async function decideComputerRequest<T>(store: ComputerRequestStore, userId: string, sessionId: string, id: string, approve: boolean, config: DesktopConfig, execute: (config: DesktopConfig, operation: ComputerOperation) => Promise<T>, now = new Date()) {
  const request = await store.consume(id, userId, sessionId, desktopFingerprint(config), now, approve ? 'executing' : 'denied')
  if (!request) throw new Error('Request expired, changed, or already decided')
  if (!approve) return { status: 'denied' as const }
  // Body contains only id/session/decision, not caller-controlled arguments.
  // Revalidate saved normalized args before execution. Claim happens BEFORE
  // network I/O; failure/uncertainty never refunds an approval for retries.
  try {
    const operation = normalizedOperation(request.operation)
    const canonical = (v: object) => JSON.stringify(v, Object.keys(v).sort())
    if (canonical(operation) !== canonical(request.operation)) throw new Error('Saved operation is not normalized')
    const result = await execute(config, operation)
    await store.finish(id, 'complete')
    return { status: 'complete' as const, result }
  } catch (error) { await store.finish(id, 'failed'); throw error }
}
