import { DEVICE_SESSION_CLOSE_GRACE_MS, type DeviceSessionReport } from '@mikka/protocol/device'

/** Applies one report to the application, in this process. Throws to be retried. */
export type ReportDeviceSession = (deviceId: string, report: DeviceSessionReport) => Promise<unknown>
export type SessionReportOptions = { report?: ReportDeviceSession; closeGraceMs?: number; retryMinMs?: number; retryMaxMs?: number }

type Queue = { reports: DeviceSessionReport[]; attempts: number; running: boolean; timer?: ReturnType<typeof setTimeout> }
type PendingClose = { connection: string; timer: ReturnType<typeof setTimeout> }

/**
 * The built-in gateway's device session reports (decision 2026-11-17-2215),
 * the in-process twin of the Worker's `DeviceSession` reports.
 *
 * Only the replica holding a socket reports it. `connected` is sent once the
 * socket's claim is ordered by PostgreSQL; `disconnected` after the close
 * grace, unless any replica claimed a newer socket for the device meanwhile.
 * Each device's reports are applied one at a time, in order, and a failure is
 * retried with backoff (1 s doubling to 60 s) until it succeeds.
 *
 * A replica that stops drops its pending reports and timers: its sockets'
 * daemons reconnect to another replica, which reports `connected`, and a
 * device that does not come back is caught by the application's run-recovery
 * backstop, which asks the gateway for the device's status.
 */
export class DeviceSessionReports {
  private queues = new Map<string, Queue>()
  private closes = new Map<string, PendingClose>()
  private stopped = false
  private readonly graceMs: number
  private readonly retryMinMs: number
  private readonly retryMaxMs: number

  constructor(private now: () => number, private options: SessionReportOptions = {}) {
    this.graceMs = options.closeGraceMs ?? DEVICE_SESSION_CLOSE_GRACE_MS
    this.retryMinMs = options.retryMinMs ?? 1_000
    this.retryMaxMs = options.retryMaxMs ?? 60_000
  }

  get enabled() { return !!this.options.report && !this.stopped }

  /** This replica's socket was claimed: it is the device's session now. */
  opened(deviceId: string, connection: string, socketId: string, openedAt: number) {
    if (!this.enabled) return
    this.claimed(deviceId, connection)
    this.enqueue(deviceId, { state: 'connected', at: new Date(openedAt).toISOString(), socketId })
  }

  /** Any replica claimed a socket for this device: a close still in its grace is not the session's end. */
  claimed(deviceId: string, connection: string) {
    const close = this.closes.get(deviceId)
    if (!close || close.connection === connection) return
    clearTimeout(close.timer)
    this.closes.delete(deviceId)
  }

  /** This replica's current socket closed (never called for a replaced one). */
  closed(deviceId: string, connection: string, socketId: string, closedAt: number) {
    if (!this.enabled || this.closes.get(deviceId)?.connection === connection) return
    clearTimeout(this.closes.get(deviceId)?.timer)
    const timer = setTimeout(() => {
      if (this.closes.get(deviceId)?.timer !== timer) return
      this.closes.delete(deviceId)
      this.enqueue(deviceId, { state: 'disconnected', at: new Date(closedAt).toISOString(), socketId })
    }, Math.max(0, closedAt + this.graceMs - this.now()))
    timer.unref?.()
    this.closes.set(deviceId, { connection, timer })
  }

  private enqueue(deviceId: string, report: DeviceSessionReport) {
    const queue = this.queues.get(deviceId) ?? { reports: [], attempts: 0, running: false }
    queue.reports.push(report)
    this.queues.set(deviceId, queue)
    if (!queue.timer) void this.drain(deviceId, queue)
  }

  private async drain(deviceId: string, queue: Queue) {
    if (queue.running) return
    queue.running = true
    try {
      while (queue.reports.length && !this.stopped) {
        try { await this.options.report!(deviceId, queue.reports[0]!) }
        catch (error) {
          if (this.stopped) return
          queue.attempts++
          const wait = Math.min(this.retryMaxMs, this.retryMinMs * 2 ** (queue.attempts - 1))
          console.warn('[builtin-gateway] device session report failed', { state: queue.reports[0]!.state, attempt: queue.attempts,
            error: error instanceof Error ? error.name : 'unknown' })
          queue.timer = setTimeout(() => { delete queue.timer; void this.drain(deviceId, queue) }, wait)
          queue.timer.unref?.()
          return
        }
        queue.attempts = 0
        queue.reports.shift()
      }
      if (!queue.reports.length && this.queues.get(deviceId) === queue) this.queues.delete(deviceId)
    } finally { queue.running = false }
  }

  stop() {
    this.stopped = true
    for (const close of this.closes.values()) clearTimeout(close.timer)
    for (const queue of this.queues.values()) clearTimeout(queue.timer)
    this.closes.clear(); this.queues.clear()
  }
}
