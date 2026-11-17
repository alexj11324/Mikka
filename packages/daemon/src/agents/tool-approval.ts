// A run's live gate: whether the run may still act, and its revocation.
// Agent CLIs ask nothing per tool or destination (decision 2026-11-01-2335:
// Claude Code in bypassPermissions, Codex with approvals "never"); this gate
// only stops a run whose lease, owner or policy is no longer live.
//
// Run control is pushed (decision 2026-11-17-2215): the server wakes the
// device session after every stop, pause, revocation and policy change, and
// the daemon calls `invalidate` on each push and when the socket opens again.
// There is no timer. While the socket is down the run's local lease decides
// (runs/supervisor.ts); its controls are read again when it reconnects.

export interface ToolApprovalHost {
  /** Must reflect current run lease, owner, and revocation state. */
  isLive(runId: string): boolean | Promise<boolean>
}

/** setTimeout's ceiling; a later due time re-arms when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** A watcher's check may return an epoch ms (an expiry) by which it must run again. */
type WatchCheck = () => Promise<unknown>
type Watcher = { check?: WatchCheck; running: boolean; dirty: boolean; due?: ReturnType<typeof setTimeout> }
export type WatchOptions = {
  /** Epoch ms by which the check first runs (an expiry already known), as if
   * a first check had returned it. */
  dueAt?: number
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
  private readonly monitors = new Set<Watcher>()
  private monitoring?: Promise<void>
  private dirty = false
  private readonly changes = new Set<() => void>()
  constructor(readonly runId: string, private readonly host: ToolApprovalHost) {}
  revoke(reason?: 'device_lost') {
    if (this.revoked) return
    this.reason = reason
    for (const monitor of this.monitors) clearTimeout(monitor.due)
    this.monitors.clear()
    this.stop.abort()
    this.wake()
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
      const work = Promise.resolve().then(() => this.revoked ? false : this.host.isLive(this.runId))
      this.checking = abortable(work, this.stop.signal)
        .then(live => live && !this.revoked, () => false)
        .finally(() => { this.checking = undefined })
    }
    return this.checking
  }

  /** Resolves on the next push or revocation. A paused run waits here instead
   * of asking the server on a timer. */
  changed(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted || this.revoked) { reject(new Error('cancelled')); return }
      const done = (error?: Error) => {
        this.changes.delete(wake)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const wake = () => done(this.revoked ? new Error('cancelled') : undefined)
      const abort = () => done(new Error('cancelled'))
      this.changes.add(wake)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  private wake() { for (const wake of [...this.changes]) wake() }

  /** Watches the run while it lasts: one background liveness check per push
   * (invalidate). Extra checks (credentials, subscription access) share each
   * fresh result; a check may return an epoch ms (an expiry) by which it runs
   * again. Actual operations still call checkLive. Slow credential I/O never
   * delays the next liveness check. */
  watch(check?: WatchCheck, options: WatchOptions = {}): () => void {
    if (this.revoked) return () => {}
    const monitor: Watcher = { check, running: false, dirty: false }
    this.monitors.add(monitor)
    if (options.dueAt !== undefined) this.due(monitor, options.dueAt)
    return () => { clearTimeout(monitor.due); this.monitors.delete(monitor) }
  }
  /** One timer per watcher at its reported due time, never a cadence. */
  private due(monitor: Watcher, at: unknown) {
    clearTimeout(monitor.due)
    monitor.due = undefined
    if (typeof at !== 'number' || !Number.isFinite(at) || this.revoked || !this.monitors.has(monitor)) return
    monitor.due = setTimeout(() => {
      monitor.due = undefined
      if (at > Date.now()) this.due(monitor, at)
      else this.invalidate()
    }, Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS))
    monitor.due.unref?.()
  }
  /** A push invalidates an in-flight check as well as a settled one. */
  invalidate() {
    this.wake()
    this.requestCheck()
  }
  private requestCheck() {
    if (this.revoked || !this.monitors.size) return
    this.dirty = true
    if (this.monitoring) return
    // A real operation may have started the shared HTTP request before this
    // push, while no background check existed yet. Its old success cannot
    // satisfy the invalidation; finish it, then issue one fresh request.
    let olderOperation = this.checking !== undefined
    this.monitoring = (async () => {
      while (this.dirty && !this.revoked && this.monitors.size) {
        this.dirty = false
        if (!await this.checkLive()) { this.revoke(); return }
        if (olderOperation) { olderOperation = false; this.dirty = true; continue }
        for (const monitor of this.monitors) {
          if (!monitor.check) continue
          monitor.dirty = true
          if (monitor.running) continue
          monitor.running = true
          void (async () => {
            while (monitor.dirty && !this.revoked && this.monitors.has(monitor)) {
              monitor.dirty = false
              const due = await monitor.check!()
              this.due(monitor, due)
            }
          })().catch(() => { if (this.monitors.has(monitor)) this.revoke() })
            .finally(() => { monitor.running = false })
        }
      }
    })().finally(() => {
      this.monitoring = undefined
      if (this.dirty) this.requestCheck()
    })
  }
}

export function requireRunToolApproval(runId: string, gate?: ToolApprovalGate): ToolApprovalGate {
  if (!gate || gate.runId !== runId || gate.revoked) throw new Error('Run tool approval unavailable')
  return gate
}
