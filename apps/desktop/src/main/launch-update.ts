// The launch gate (Alex, 2026-11-02): on a cold start the app checks for an
// update before it opens, and a newer version is installed before the person
// gets in. No update, no network, or no answer within CHECK_TIMEOUT_MS: the
// app opens as usual; a failed check never locks anyone out. A failed
// download shows why and offers 重试, but not "use the old version".

export const CHECK_TIMEOUT_MS = 5_000

/** The part of electron-updater's `autoUpdater` the gate listens to. */
export interface GateUpdater {
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

export type GateState =
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; version: string; reason: string }

export interface GateOptions {
  /** Each state the window shows. */
  onState(state: GateState): void
  /** Open once. Retry in the background only if the launch check was inconclusive. */
  onProceed(retryCheck: boolean): void
  timeoutMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** The first line of an updater error, for the window; never a stack. */
export function failureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return (text.split('\n').map(line => line.trim()).find(Boolean) ?? '').slice(0, 200)
}

export class UpdateGate {
  state: GateState = { kind: 'checking' }
  private finished = false
  private timer: unknown = null
  private readonly listeners: Array<[string, (...args: never[]) => void]> = []
  private readonly setTimer: NonNullable<GateOptions['setTimer']>
  private readonly clearTimer: NonNullable<GateOptions['clearTimer']>

  constructor(private readonly updater: GateUpdater, private readonly options: GateOptions) {
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? (timer => { clearTimeout(timer as ReturnType<typeof setTimeout>) })
    this.listen('update-available', (info: { version: string }) => {
      if (this.state.kind !== 'checking') return
      this.stopTimer()
      this.show({ kind: 'downloading', version: info.version, percent: 0 })
    })
    this.listen('update-not-available', () => { if (this.state.kind === 'checking') this.proceed(false) })
    this.listen('download-progress', (progress: { percent: number }) => {
      if (this.state.kind !== 'downloading') return
      const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)))
      if (percent !== this.state.percent) this.show({ ...this.state, percent })
    })
    this.listen('update-downloaded', (info: { version: string }) => {
      if (this.finished || this.state.kind === 'installing') return
      this.stopTimer()
      this.show({ kind: 'installing', version: info.version })
      this.finished = true
      this.detach()
      this.updater.quitAndInstall()
    })
    this.listen('error', (error: Error) => { this.fail(error) })
  }

  /** Starts the check; the timeout applies only until an update is found. */
  start(): void {
    this.show({ kind: 'checking' })
    this.timer = this.setTimer(() => { if (this.state.kind === 'checking') this.proceed(true) }, this.options.timeoutMs ?? CHECK_TIMEOUT_MS)
    this.check()
  }

  /** 重试 after a failed download: the same version, downloaded again. */
  retry(): void {
    if (this.state.kind !== 'failed' || this.finished) return
    this.show({ kind: 'downloading', version: this.state.version, percent: 0 })
    this.check()
  }

  private check(): void {
    void this.updater.checkForUpdates().catch((error: unknown) => { this.fail(error) })
  }

  private fail(error: unknown): void {
    if (this.finished) return
    // A check that cannot reach the server lets the person in; only a found
    // update that will not download holds the door.
    if (this.state.kind === 'checking') return this.proceed(true)
    if (this.state.kind === 'downloading') this.show({ kind: 'failed', version: this.state.version, reason: failureReason(error) })
  }

  private proceed(retryCheck: boolean): void {
    if (this.finished) return
    this.finished = true
    this.stopTimer()
    this.detach()
    this.options.onProceed(retryCheck)
  }

  private show(state: GateState): void {
    this.state = state
    this.options.onState(state)
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  private listen<T extends unknown[]>(event: string, listener: (...args: T) => void): void {
    const handler = listener as unknown as (...args: never[]) => void
    this.listeners.push([event, handler])
    ;(this.updater.on as (event: string, listener: (...args: never[]) => void) => unknown)(event, handler)
  }

  private detach(): void {
    for (const [event, listener] of this.listeners.splice(0)) this.updater.removeListener(event, listener)
  }
}

/** The window's words; Chinese unless the system language is not. */
export function gateCopy(locale: string) {
  const zh = locale.toLowerCase().startsWith('zh')
  return {
    lang: zh ? 'zh-CN' : 'en',
    title: zh ? 'Mikka 更新' : 'Mikka Update',
    checking: zh ? '正在检查更新' : 'Checking for updates',
    downloading: (version: string) => zh ? `正在更新到 v${version}` : `Updating to v${version}`,
    installing: (version: string) => zh ? `正在安装 v${version}` : `Installing v${version}`,
    failed: (version: string) => zh ? `无法更新到 v${version}` : `Could not update to v${version}`,
    retry: zh ? '重试' : 'Retry',
  }
}

/** What update.html renders for a state: a heading, an optional detail, progress and the retry button. */
export function gateView(state: GateState, copy: ReturnType<typeof gateCopy>) {
  switch (state.kind) {
    case 'checking': return { heading: copy.checking, detail: '', percent: null, retry: null, busy: true }
    case 'downloading': return { heading: copy.downloading(state.version), detail: `${state.percent}%`, percent: state.percent, retry: null, busy: true }
    case 'installing': return { heading: copy.installing(state.version), detail: '', percent: 100, retry: null, busy: true }
    case 'failed': return { heading: copy.failed(state.version), detail: state.reason, percent: null, retry: copy.retry, busy: false }
  }
}
