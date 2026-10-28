// Run-bound CLI approval bridge. Host callbacks are injected in-process by
// trusted daemon code; model-facing request data never supplies authority.
import { randomUUID } from 'node:crypto'
import type { PermissionDecision } from '@mikka/protocol/agent-policy'

export interface ToolApprovalRequest {
  runId: string
  harness: 'codex' | 'claude_code'
  requestId: string
  method: string
  input: unknown
}
export interface ToolApprovalHost {
  /** Must derive the decision from trusted effective policy, not model input. */
  permission(request: Readonly<ToolApprovalRequest>): PermissionDecision | Promise<PermissionDecision>
  /** Authenticated host flow, bound to the exact request and this signal. */
  ask(request: Readonly<ToolApprovalRequest>, signal: AbortSignal): Promise<'allow' | 'deny'>
  /** Must reflect current run lease, owner, and revocation state. */
  isLive(runId: string): boolean | Promise<boolean>
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('cancelled')
  let cancel!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
  })
  try { return await Promise.race([work, cancelled]) }
  finally { signal.removeEventListener('abort', cancel) }
}

export class ToolApprovalGate {
  private readonly epoch = randomUUID()
  private readonly seen = new Set<string>()
  private readonly stop = new AbortController()
  constructor(readonly runId: string, private readonly host: ToolApprovalHost) {}
  revoke() { this.stop.abort() }

  async request(request: ToolApprovalRequest, signal?: AbortSignal): Promise<'allow' | 'deny'> {
    if (request.runId !== this.runId || !request.requestId || request.requestId.length > 219 || this.seen.has(request.requestId) || this.seen.size >= 1024 || this.stop.signal.aborted || signal?.aborted) return 'deny'
    let snapshot: ToolApprovalRequest
    try {
      const serialized = JSON.stringify(request)
      if (serialized.length > 20_000) return 'deny'
      snapshot = JSON.parse(serialized) as ToolApprovalRequest
      snapshot.requestId = `${this.epoch}/${snapshot.requestId}`
    } catch { return 'deny' }
    this.seen.add(request.requestId) // consume before asynchronous work; never refund
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.stop.signal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (this.stop.signal.aborted || signal?.aborted || !await abortable(Promise.resolve(this.host.isLive(this.runId)), controller.signal)) return 'deny'
      const permission = await abortable(Promise.resolve(this.host.permission(snapshot)), controller.signal)
      if (!await abortable(Promise.resolve(this.host.isLive(this.runId)), controller.signal) || controller.signal.aborted) return 'deny'
      if (permission === 'deny') return 'deny'
      if (permission === 'allow') return 'allow'
      if (permission !== 'ask') return 'deny'
      const decision = await abortable(this.host.ask(snapshot, controller.signal), controller.signal)
      if (!await abortable(Promise.resolve(this.host.isLive(this.runId)), controller.signal) || controller.signal.aborted) return 'deny'
      return decision === 'allow' ? 'allow' : 'deny'
    } catch {
      return 'deny'
    } finally {
      this.stop.signal.removeEventListener('abort', abort)
      signal?.removeEventListener('abort', abort)
    }
  }
}
