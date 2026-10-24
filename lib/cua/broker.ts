import type { ComputerOperation, DesktopConfig } from './operation'
import { desktopFingerprint, normalizedOperation } from './operation'

export type ComputerRequest = { id: string; userId: string; sessionId: string; workspaceId: string; target: string; operation: ComputerOperation; status: string; expiresAt: Date }
export interface ComputerRequestStore {
  pending(userId: string, sessionId: string): Promise<ComputerRequest[]>
  insert(request: ComputerRequest): Promise<void>
  // Atomic conditional update; a consumed, denied, expired or differently
  // scoped request can never be admitted a second time.
  consume(id: string, userId: string, sessionId: string, target: string, now: Date, status: 'executing' | 'denied'): Promise<ComputerRequest | null>
  read(id: string, userId: string, sessionId: string, target: string): Promise<ComputerRequest | null>
  cancel(id: string, userId: string, sessionId: string): Promise<void>
  approve(id: string, userId: string, sessionId: string, target: string, now: Date): Promise<ComputerRequest | null>
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

// The live model tool owns execution/result delivery. The owner's HTTP tap only
// approves immutable saved arguments; it never receives or stores screenshot bytes.
export async function waitForComputerRequest<T>(store: ComputerRequestStore, userId: string, sessionId: string, config: DesktopConfig, value: unknown, execute: (config: DesktopConfig, operation: ComputerOperation, signal?: AbortSignal) => Promise<T>, signal: AbortSignal, options: { pollMs?: number; timeoutMs?: number } = {}) {
  signal.throwIfAborted()
  const prepared = await prepareComputerRequest(store, userId, sessionId, config, value)
  const id = prepared.requestId
  const target = desktopFingerprint(config)
  const deadline = Date.now() + (options.timeoutMs ?? 120000)
  try {
    while (true) {
      signal.throwIfAborted()
      const row = await store.read(id, userId, sessionId, target)
      if (!row || row.expiresAt.getTime() <= Date.now() || Date.now() >= deadline || ['denied', 'cancelled', 'failed'].includes(row.status)) throw new Error('Computer request denied, stopped or expired')
      if (row.status === 'approved') {
        // consume rechecks active membership, workspace deny and expiry under
        // the workspace lock. Only one waiter can claim approved -> executing.
        const claimed = await store.consume(id, userId, sessionId, target, new Date(), 'executing')
        if (!claimed) throw new Error('Computer approval no longer executable')
        try {
          signal.throwIfAborted()
          const operation = normalizedOperation(claimed.operation)
          if (JSON.stringify(operation) !== JSON.stringify(prepared.operation)) throw new Error('Saved operation changed')
          const result = await execute(config, operation, signal)
          await store.finish(id, 'complete')
          return result
        } catch (error) { await store.finish(id, 'failed'); throw error }
      }
      if (row.status !== 'pending') throw new Error('Computer request already consumed')
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Stopped')) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, options.pollMs ?? 500)
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })
    }
  } finally {
    // Only unclaimed work can be cancelled. Unknown in-flight effects remain
    // consumed/failed and can never be refunded for an automatic retry.
    await store.cancel(id, userId, sessionId)
  }
}
