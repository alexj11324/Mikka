// Background updates: electron-updater downloads a new release quietly, and
// only a downloaded one reaches the web UI, which shows the rail's restart
// button. The menu's "Check for Updates…" is the only path that reports.

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** The part of electron-updater's `autoUpdater` this module drives. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

/** Native messages for an interactive check. */
export interface UpdateReport {
  /** A newer version is downloading or already downloaded. */
  available(version: string): void
  upToDate(): void
  failed(error: Error): void
}

export class Updates {
  /** The downloaded version, waiting for a restart. */
  ready: string | null = null
  private interactive = false

  constructor(private readonly updater: Updater, private readonly report: UpdateReport, onReady: (version: string) => void) {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('update-available', info => {
      if (this.take()) report.available(info.version)
    })
    updater.on('update-not-available', () => {
      if (this.take()) report.upToDate()
    })
    updater.on('update-downloaded', info => {
      this.ready = info.version
      onReady(info.version)
    })
    updater.on('error', error => {
      if (this.take()) report.failed(error)
    })
  }

  /** A background check stays silent; once a version is downloaded there is nothing left to check. */
  async check(interactive: boolean): Promise<void> {
    if (this.ready) {
      if (interactive) this.report.available(this.ready)
      return
    }
    this.interactive = interactive
    await this.updater.checkForUpdates().catch((error: Error) => {
      if (this.take()) this.report.failed(error)
    })
  }

  install(): void {
    if (this.ready) this.updater.quitAndInstall()
  }

  private take(): boolean {
    const interactive = this.interactive
    this.interactive = false
    return interactive
  }
}
