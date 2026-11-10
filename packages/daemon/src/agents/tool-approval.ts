// A run's live gate: whether the run may still act, and its revocation.
//
// Tool approvals are not a mode. A run asks a person about one native call
// exactly when its resolved policy says `ask` for that action; a policy with
// no such action asks nothing per tool (decision 2026-11-01-2335). Reading vs
// writing is separate and already settled by the read-only policy, so this
// gate never decides that.

import type { ToolApprovalMethod } from '@mikka/protocol/tool-approval'

export interface ToolApprovalRequest {
  requestId: string
  method: ToolApprovalMethod
  tool: string
  input: Record<string, unknown>
}

export interface ToolApprovalHost {
  /** Must reflect current run lease, owner, and revocation state. */
  isLive(runId: string): boolean | Promise<boolean>
  /** Ask the server to store and wait for one decision; absent fails closed. */
  requestApproval?(runId: string, request: ToolApprovalRequest, signal: AbortSignal): Promise<'approved' | 'denied'>
}

/** How a gate learns that run control may have changed (#1212).
 * - `legacy`: the server predates run-control push; check every second, as before.
 * - `push`: the device gateway is connected to a server that pushes every stop,
 *   pause, revocation and policy change; no timer, one check per push.
 * - `fallback`: the gateway is down on a server that pushes; one check every
 *   RUN_CONTROL_FALLBACK_MS (stops also arrive through the commands long-poll). */
export type RunControlMode = 'legacy' | 'push' | 'fallback'
export const RUN_CONTROL_LEGACY_MS = 1_000
export const RUN_CONTROL_FALLBACK_MS = 20_000
const cadence = (mode: RunControlMode) => mode === 'push' ? undefined : mode === 'fallback' ? RUN_CONTROL_FALLBACK_MS : RUN_CONTROL_LEGACY_MS
/** setTimeout's ceiling; a later due time re-arms when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** A watcher's check may return an epoch ms (an expiry) by which it must run again. */
type WatchCheck = () => Promise<unknown>
type Watcher = { check?: WatchCheck; running: boolean; dirty: boolean; intervalMs?: number; timedFloorMs?: number; lastRun?: number; due?: ReturnType<typeof setTimeout> }
export type WatchOptions = {
  /** A timer tick (not a push, mode switch or due time) runs this watcher's
   * check at most this often. For a costly check whose changes are pushed or
   * bounded by its own due time; the liveness check still runs every tick. */
  timedFloorMs?: number
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
  private timer?: ReturnType<typeof setInterval>
  private intervalMs?: number
  private monitoring?: Promise<void>
  private dirty = false
  /** A push, mode switch or due time is waiting for the monitor loop. */
  private pushed = false
  private mode: RunControlMode
  private readonly changes = new Set<() => void>()
  constructor(readonly runId: string, private readonly host: ToolApprovalHost, mode: RunControlMode = 'legacy', /** The policy actions this run must ask about; empty asks nothing. */ private readonly askActions: readonly string[] = []) { this.mode = mode }
  revoke(reason?: 'device_lost') {
    if (this.revoked) return
    this.reason = reason
    clearInterval(this.timer)
    this.timer = undefined
    for (const monitor of this.monitors) clearTimeout(monitor.due)
    this.monitors.clear()
    this.stop.abort()
    this.wake()
  }
  get revoked(): boolean { return this.stop.signal.aborted }
  get revokeReason(): 'device_lost' | undefined { return this.reason }
  get controlMode(): RunControlMode { return this.mode }
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

  /** Whether this run asks a person about `action` at all. */
  asks(action: string): boolean {
    return this.askActions.includes(action)
  }

  /** Whether this run asks about anything: its adapter needs the gate wired. */
  get asksAny(): boolean {
    return this.askActions.length > 0
  }

  /**
   * One risky native tool request for `action`. A run whose policy resolves
   * `allow` for it keeps the existing live-run behavior; a policy that
   * resolves `ask` asks the server and waits for the person; a read-only
   * policy denies before this is reached. A missing transport, a refused
   * decision, a lost lease or an abort is a denial — never an allow.
   */
  async requestApproval(request: ToolApprovalRequest, signal?: AbortSignal, action = 'run_project_script'): Promise<boolean> {
    if (this.revoked) return false
    if (!this.asks(action)) return this.checkLive()
    if (!await this.checkLive()) return false
    if (!this.host.requestApproval) return false
    const effective = signal ?? this.stop.signal
    try {
      const decision = await abortable(Promise.resolve().then(() => this.host.requestApproval!(this.runId, request, effective)), effective)
      return decision === 'approved' && !this.revoked && await this.checkLive()
    } catch {
      return false
    }
  }

  /** Switches how this gate learns of changes. Any switch checks again at
   * once: a push may have been lost while the socket was changing state. */
  setControlMode(mode: RunControlMode) {
    if (this.revoked || mode === this.mode) return
    this.mode = mode
    this.scheduleMonitor()
    this.invalidate()
  }

  /** Resolves on the next push or mode switch, or after the mode's cadence.
   * A paused run waits here instead of asking the server every second. */
  changed(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted || this.revoked) { reject(new Error('cancelled')); return }
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (error?: Error) => {
        clearTimeout(timer)
        this.changes.delete(wake)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const wake = () => done(this.revoked ? new Error('cancelled') : undefined)
      const abort = () => done(new Error('cancelled'))
      const ms = cadence(this.mode)
      if (ms !== undefined) timer = setTimeout(wake, ms)
      this.changes.add(wake)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  private wake() { for (const wake of [...this.changes]) wake() }

  /** Watches the run while it lasts: one background liveness check per run,
   * on each push (invalidate) and, only when the gateway cannot push, on the
   * mode's cadence. Extra checks (credentials, subscription access) share each
   * fresh result; a check may return an epoch ms (an expiry) by which it runs
   * again. Actual operations still call checkLive. Slow credential I/O never
   * delays the next liveness check. `intervalMs` only shortens a timed cadence. */
  watch(check?: WatchCheck, intervalMs?: number, options: WatchOptions = {}): () => void {
    if (this.revoked) return () => {}
    if (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > RUN_CONTROL_FALLBACK_MS)) throw new Error('Run monitor interval unavailable')
    const { timedFloorMs } = options
    if (timedFloorMs !== undefined && (!Number.isFinite(timedFloorMs) || timedFloorMs <= 0)) throw new Error('Run monitor interval unavailable')
    const monitor: Watcher = { check, running: false, dirty: false, intervalMs, timedFloorMs }
    this.monitors.add(monitor)
    this.scheduleMonitor()
    if (options.dueAt !== undefined) this.due(monitor, options.dueAt)
    return () => { clearTimeout(monitor.due); this.monitors.delete(monitor); this.scheduleMonitor() }
  }
  private scheduleMonitor() {
    const base = cadence(this.mode)
    const intervalMs = this.monitors.size && base !== undefined
      ? Math.min(base, ...[...this.monitors].flatMap(monitor => monitor.intervalMs ?? [])) : undefined
    if (intervalMs === this.intervalMs) return
    clearInterval(this.timer)
    this.intervalMs = intervalMs
    this.timer = intervalMs === undefined ? undefined : setInterval(() => this.requestCheck(false), intervalMs)
    this.timer?.unref()
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
    this.requestCheck(true)
  }
  private requestCheck(invalidated: boolean) {
    if (this.revoked || !this.monitors.size) return
    if (this.monitoring && !invalidated) return
    this.dirty = true
    if (invalidated) this.pushed = true
    if (this.monitoring) return
    // A real operation may have started the shared HTTP request before this
    // push, while no background check existed yet. Its old success cannot
    // satisfy the invalidation; finish it, then issue one fresh request.
    let olderOperation = invalidated && this.checking !== undefined
    this.monitoring = (async () => {
      while (this.dirty && !this.revoked && this.monitors.size) {
        this.dirty = false
        const pushed = this.pushed
        this.pushed = false
        if (!await this.checkLive()) { this.revoke(); return }
        if (olderOperation) { olderOperation = false; this.dirty = true; this.pushed ||= pushed; continue }
        for (const monitor of this.monitors) {
          if (!monitor.check) continue
          if (!pushed && monitor.timedFloorMs !== undefined && monitor.lastRun !== undefined && performance.now() - monitor.lastRun < monitor.timedFloorMs) continue
          monitor.dirty = true
          if (monitor.running) continue
          monitor.running = true
          void (async () => {
            while (monitor.dirty && !this.revoked && this.monitors.has(monitor)) {
              monitor.dirty = false
              monitor.lastRun = performance.now()
              const due = await monitor.check!()
              this.due(monitor, due)
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
