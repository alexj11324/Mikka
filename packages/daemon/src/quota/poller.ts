// Reads a QuotaSource only when the desktop explicitly requests a fresh report.
// Vendor quota endpoints do not expose a push feed; never poll them while idle.
import {
  quotaSnapshotReportSchema,
  unknownQuotaReport,
  type QuotaSnapshot,
  type QuotaSnapshotReport,
} from "@mikka/protocol"

import type { Logger } from "../log"
import { sanitizeError } from "./files"

export interface QuotaSource {
  readonly id: "local_credentials" | "official"
  read(signal?: AbortSignal): Promise<QuotaSnapshot[]>
}

export interface QuotaPollerOptions {
  log?: Logger
}

export class QuotaPoller {
  private current: QuotaSnapshotReport = unknownQuotaReport()
  private inflight: Promise<void> | null = null
  private readonly abort = new AbortController()

  constructor(
    private readonly source: QuotaSource,
    options: QuotaPollerOptions = {}
  ) {
    this.log = options.log
  }

  private readonly log: Logger | undefined

  async stop() {
    this.abort.abort()
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
