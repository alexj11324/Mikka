/** A request owns one lifetime, registered before output. Promises already run;
 * callbacks start only at the transport's actual response-disposal boundary. */
export class AfterQueue {
  private tasks: Array<() => unknown> = []
  private finishing?: Promise<void>
  private closed = false
  private resolve!: () => void
  readonly lifetime = new Promise<void>(resolve => { this.resolve = resolve })
  constructor(private readonly report: (error: unknown) => void = error => {
    console.error('api_after_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
  }) {}
  add(task: (() => unknown) | PromiseLike<unknown>): void {
    if (this.closed) throw new Error('API_RESPONSE_LIFETIME_ENDED')
    if (typeof task === 'function') this.tasks.push(task)
    else {
      // Attach rejection now: an already-running promise can fail before the
      // response closes. Its result is still joined by the owned lifetime.
      const pending = Promise.resolve(task).then(() => undefined, error => { this.report(error) })
      this.tasks.push(() => pending)
    }
  }
  finish(): Promise<void> {
    return this.finishing ??= (async () => {
      try {
        for (let index = 0; index < this.tasks.length; index++) {
          try { await this.tasks[index]() } catch (error) { this.report(error) }
        }
      } finally { this.closed = true; this.resolve() }
    })()
  }
}
