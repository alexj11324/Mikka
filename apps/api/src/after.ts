/** A request owns one lifetime, registered before output. Promises already run;
 * callbacks start only at the transport's actual response-disposal boundary. */
export class AfterQueue {
  private tasks: Array<() => unknown> = []
  private finishing?: Promise<void>
  private active = 0
  private closed = false
  private resolve!: () => void
  readonly lifetime = new Promise<void>(resolve => { this.resolve = resolve })
  constructor(private readonly report: (error: unknown) => void = error => {
    console.error('api_after_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
  }) {}
  add(task: (() => unknown) | PromiseLike<unknown>): void {
    if (this.closed) throw new Error('API_RESPONSE_LIFETIME_ENDED')
    let callback: () => unknown
    if (typeof task === 'function') callback = task
    else {
      // Attach rejection now: an already-running promise can fail before the
      // response closes. Its result is still joined by the owned lifetime.
      const pending = Promise.resolve(task).then(() => undefined, error => { this.reportError(error) })
      callback = () => pending
    }
    if (this.finishing) this.start(callback)
    else this.tasks.push(callback)
  }
  finish(): Promise<void> {
    if (!this.finishing) {
      this.finishing = this.lifetime
      // Next's paused PQueue starts independent callbacks concurrently. A slow
      // recording cleanup must not delay coordinator wakes or outcome judges.
      for (const task of this.tasks) this.start(task)
      this.tasks = []
      if (!this.active) this.close()
    }
    return this.finishing
  }
  private start(task: () => unknown): void {
    this.active++
    const done = () => { if (--this.active === 0) this.close() }
    void Promise.resolve().then(task).then(done, error => { this.reportError(error); done() })
  }
  private close(): void { this.closed = true; this.resolve() }
  private reportError(error: unknown): void {
    try { this.report(error) }
    catch { console.error('api_after_report_failed') }
  }
}
