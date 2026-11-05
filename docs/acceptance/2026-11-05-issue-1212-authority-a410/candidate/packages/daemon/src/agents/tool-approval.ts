// A run's live gate: whether the run may still act, and its revocation.
// Agent CLIs ask nothing per tool or destination (decision 2026-11-01-2335:
// Claude Code in bypassPermissions, Codex with approvals "never"); this gate
// only stops a run whose lease, owner or policy is no longer live.

import { RunAuthorityLease, type RunAuthoritySource } from './run-authority'

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
  private checking?: Promise<boolean>
  private reason?: 'device_lost'
  private readonly monitors = new Set<{ check?: () => Promise<unknown>; running: boolean; dirty: boolean; intervalMs: number }>()
  private timer?: ReturnType<typeof setInterval>
  private intervalMs?: number
  private monitoring?: Promise<void>
  private dirty = false
  private readonly authority?: RunAuthorityLease
  constructor(readonly runId: string, private readonly host: ToolApprovalHost, source?: RunAuthoritySource) {
    if (source) {
      this.authority = new RunAuthorityLease(runId,source,()=>this.revoke())
      this.authority.start()
    }
  }
  revoke(reason?: 'device_lost') {
    if (this.revoked) return
    this.reason = reason
    clearInterval(this.timer)
    this.timer = undefined
    this.monitors.clear()
    this.authority?.close()
    this.stop.abort()
  }
  get revoked(): boolean { return this.stop.signal.aborted }
  get revokeReason(): 'device_lost' | undefined { return this.reason }
  onRevoke(callback: () => void): () => void {
    if (this.revoked) { callback(); return () => {} }
    this.stop.signal.addEventListener('abort', callback, { once: true })
    return () => this.stop.signal.removeEventListener('abort', callback)
  }
  async checkLive(): Promise<boolean> {
    if (this.revoked) return false
    if (!this.checking) {
      const work = Promise.resolve().then(async () => {
        if (this.revoked || (this.authority && (!await this.authority.ready || !this.authority.current))) return false
        // Even with a source lease, every operation still gets a fresh answer
        // from the original host. Only its redundant background poll changes.
        const live = await this.host.isLive(this.runId)
        return live && (!this.authority || this.authority.current)
      })
      this.checking = abortable(work, this.stop.signal)
        .then(live => live && !this.revoked, () => false)
        .finally(() => { this.checking = undefined })
    }
    return this.checking
  }

  /** One background liveness check per run. Extra credential checks share its
   * fresh result for that tick only; actual operations still call checkLive.
   * Slow credential I/O must never delay the next liveness check. */
  monitor(check?: () => Promise<unknown>, intervalMs = 1000): () => void {
    if (this.revoked) return () => {}
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 1000) throw new Error('Run monitor interval unavailable')
    const monitor = { check, running: false, dirty: false, intervalMs }
    this.monitors.add(monitor)
    this.scheduleMonitor()
    return () => { this.monitors.delete(monitor); this.scheduleMonitor() }
  }
  private scheduleMonitor() {
    const monitored = [...this.monitors].filter(monitor => !this.authority || monitor.check)
    const intervalMs = monitored.length ? Math.min(...monitored.map(monitor => monitor.intervalMs)) : undefined
    if (intervalMs === this.intervalMs) return
    clearInterval(this.timer)
    this.intervalMs = intervalMs
    this.timer = intervalMs === undefined ? undefined : setInterval(() => this.requestCheck(false), intervalMs)
    this.timer?.unref()
  }
  /** Legacy clients retain the one-second safety timer. A negotiated source
   * handles lost hints using its independent bounded authority challenges. */
  invalidate() {
    if (this.authority) this.authority.invalidate()
    this.requestCheck(true)
  }
  private requestCheck(invalidated: boolean) {
    if (this.revoked || !this.monitors.size) return
    if (this.monitoring && !invalidated) return
    this.dirty = true
    if (this.monitoring) return
    // A real operation may have started the shared HTTP request before this
    // push, while no background check existed yet. Its old success cannot
    // satisfy the invalidation; finish it, then issue one fresh request.
    let olderOperation = invalidated && this.checking !== undefined
    this.monitoring = (async () => {
      while (this.dirty && !this.revoked && this.monitors.size) {
        this.dirty = false
        if (!(this.authority ? await this.authority.ready && this.authority.current : await this.checkLive())) { this.revoke(); return }
        if (olderOperation) { olderOperation = false; this.dirty = true; continue }
        for (const monitor of this.monitors) {
          if (!monitor.check) continue
          monitor.dirty = true
          if (monitor.running) continue
          monitor.running = true
          void (async () => {
            while (monitor.dirty && !this.revoked && this.monitors.has(monitor)) {
              monitor.dirty = false
              await monitor.check!()
            }
          })().catch(() => { if (this.monitors.has(monitor)) this.revoke() })
            .finally(() => { monitor.running = false })
        }
      }
    })().finally(() => {
      this.monitoring = undefined
      if (this.dirty) this.requestCheck(true)
    })
  }
}

export function requireRunToolApproval(runId: string, gate?: ToolApprovalGate): ToolApprovalGate {
  if (!gate || gate.runId !== runId || gate.revoked) throw new Error('Run tool approval unavailable')
  return gate
}

