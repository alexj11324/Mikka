// A run's live gate: whether the run may still act, and its revocation.
// Agent CLIs ask nothing per tool or destination (decision 2026-11-01-2335:
// Claude Code in bypassPermissions, Codex with approvals "never"); this gate
// only stops a run whose lease, owner or policy is no longer live.

export interface ToolApprovalHost {
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
  private readonly stop = new AbortController()
  constructor(readonly runId: string, private readonly host: ToolApprovalHost) {}
  revoke() { this.stop.abort() }
  get revoked(): boolean { return this.stop.signal.aborted }
  onRevoke(callback: () => void): () => void {
    if (this.revoked) { callback(); return () => {} }
    this.stop.signal.addEventListener('abort', callback, { once: true })
    return () => this.stop.signal.removeEventListener('abort', callback)
  }
  async checkLive(): Promise<boolean> {
    if (this.revoked) return false
    try { return await abortable(Promise.resolve(this.host.isLive(this.runId)), this.stop.signal) && !this.revoked }
    catch { return false }
  }
}

export function requireRunToolApproval(runId: string, gate?: ToolApprovalGate): ToolApprovalGate {
  if (!gate || gate.runId !== runId || gate.revoked) throw new Error('Run tool approval unavailable')
  return gate
}
