// Polls a QuotaSource and keeps the last report. Vendor calls stay on this
// timer, never on the 15s device heartbeat (ADR 0027).
import {
  quotaSnapshotReportSchema,
  unknownQuotaReport,
  type QuotaSnapshot,
  type QuotaSnapshotReport,
} from "@mikka/protocol"

import type { Logger } from "../log"
import { sanitizeError } from "./files"

/** At most one read every three minutes. */
export const QUOTA_POLL_INTERVAL_MS = 3 * 60 * 1000

export interface QuotaSource {
  readonly id: "local_credentials" | "official"
  read(signal?: AbortSignal): Promise<QuotaSnapshot[]>
}

export interface QuotaPollerOptions {
  intervalMs?: number
  log?: Logger
}

export class QuotaPoller {
  readonly intervalMs: number
  private current: QuotaSnapshotReport = unknownQuotaReport()
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<void> | null = null
  private readonly abort = new AbortController()

  constructor(
    private readonly source: QuotaSource,
    options: QuotaPollerOptions = {}
  ) {
    this.intervalMs = Math.max(
      options.intervalMs ?? QUOTA_POLL_INTERVAL_MS,
      QUOTA_POLL_INTERVAL_MS
    )
    this.log = options.log
  }

  private readonly log: Logger | undefined

  start() {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.intervalMs)
    this.timer.unref?.()
  }

  async stop() {
    this.abort.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.inflight
  }

  snapshot(): QuotaSnapshotReport {
    return this.current
  }

  refresh(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve()
    if (this.inflight) return this.inflight
    this.inflight = this.read().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async read() {
    const started = new Date().toISOString()
    try {
      const quotas = await this.source.read(this.abort.signal)
      if (this.abort.signal.aborted) return
      const parsed = quotaSnapshotReportSchema.safeParse({
        observedAt: started,
        quotas,
      })
      this.current = parsed.success
        ? parsed.data
        : { ...unknownQuotaReport(started), observedAt: started }
      this.log?.info(
        {
          quotas: this.current.quotas.map((quota) => ({
            vendor: quota.vendor,
            status: quota.status,
            windows: quota.windows.length,
          })),
        },
        "quota refreshed"
      )
    } catch (error) {
      if (this.abort.signal.aborted) return
      this.current = {
        ...unknownQuotaReport(started),
        observedAt: started,
      }
      this.log?.warn({ detail: sanitizeError(error) }, "quota refresh failed")
    }
  }
}
