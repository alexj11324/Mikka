// Background updates: electron-updater downloads a new release quietly, and
// only a downloaded one reaches the web UI, which shows the rail's restart
// button. The menu's "Check for Updates…" is the only path that opens a
// dialog: it answers the person's own question.

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

/** Native answers to a menu check. */
export interface UpdateReport {
  /** A version is downloaded: offer 立即重启 / 稍后. */
  ready(version: string): void
  upToDate(): void
  failed(error: Error): void
}

/** The menu check's words; Chinese unless the system language is not. */
export function updateCopy(locale: string) {
  return locale.toLowerCase().startsWith('zh')
    ? {
      menu: '检查更新…',
      restart: (version: string) => `重启以更新到 v${version}`,
      restartNow: '立即重启',
      later: '稍后',
      upToDate: (version: string) => `Mikka ${version} 已是最新版本`,
      failed: '无法检查更新',
      notInstalled: '安装版才会检查更新',
      ok: '好',
    }
    : {
      menu: 'Check for Updates…',
      restart: (version: string) => `Restart to update to v${version}`,
      restartNow: 'Restart Now',
      later: 'Later',
      upToDate: (version: string) => `Mikka ${version} is up to date`,
      failed: 'Could not check for updates',
      notInstalled: 'Updates are checked in the installed app',
      ok: 'OK',
    }
}

export class Updates {
  /** The downloaded version, waiting for a restart. */
  ready: string | null = null
  /** A menu check found a version that is still downloading; answer once it lands. */
  private announce = false
  private interactive = false

  constructor(private readonly updater: Updater, private readonly report: UpdateReport, onReady: (version: string) => void) {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('update-available', () => {
      if (this.take()) this.announce = true
    })
    updater.on('update-not-available', () => {
      if (this.take()) report.upToDate()
    })
    updater.on('update-downloaded', info => {
      this.ready = info.version
      onReady(info.version)
      if (this.announce) {
        this.announce = false
        report.ready(info.version)
      }
    })
    updater.on('error', error => {
      if (this.take() || this.announce) {
        this.announce = false
        report.failed(error)
      }
    })
  }

  /** A background check stays silent; once a version is downloaded there is nothing left to check. */
  async check(interactive: boolean): Promise<void> {
    if (this.ready) {
      if (interactive) this.report.ready(this.ready)
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
