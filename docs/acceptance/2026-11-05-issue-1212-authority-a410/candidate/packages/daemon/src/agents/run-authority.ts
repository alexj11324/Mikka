// Transport-independent authority lease. The source must authenticate the run
// and complete a fresh dependency barrier for each challenge before answering.
// Transport health or a delivery ACK is never a grant.
export interface RunAuthorityChallenge { runId: string; nonce: string }
export interface RunAuthorityGrant {
  runId: string
  nonce: string
  live: boolean
  /** Remaining authority at the source's fresh read, also bounded locally. */
  validForMs: number
}
export type RunAuthoritySource = (challenge: RunAuthorityChallenge, signal: AbortSignal) => Promise<RunAuthorityGrant>

// Reserve part of the old one-second check interval for actual child teardown.
const MAX_AUTHORITY_MS = 750
const CHALLENGE_INTERVAL_MS = 200

export class RunAuthorityLease {
  private readonly stop = new AbortController()
  private deadline = 0
  private granted = false
  private pending = false
  private dirty = false
  private expiry?: ReturnType<typeof setTimeout>
  private next?: ReturnType<typeof setTimeout>
  private resolveReady!: (live: boolean) => void
  readonly ready = new Promise<boolean>(resolve => { this.resolveReady = resolve })

  constructor(readonly runId: string, private readonly source: RunAuthoritySource, private readonly unavailable: () => void) {}

  get current(): boolean {
    if (!this.stop.signal.aborted && this.deadline && performance.now() >= this.deadline) this.fail()
    return this.granted && !this.stop.signal.aborted
  }

  start() { this.challenge() }

  invalidate() {
    this.dirty = true
    clearTimeout(this.next)
    this.challenge()
  }

  close() {
    if (this.stop.signal.aborted) return
    clearTimeout(this.expiry); clearTimeout(this.next)
    this.granted = false
    this.stop.abort()
    this.resolveReady(false)
  }

  private fail() {
    if (this.stop.signal.aborted) return
    this.close()
    this.unavailable()
  }

  private arm() {
    clearTimeout(this.expiry)
    const remaining = this.deadline - performance.now()
    if (remaining <= 0) { this.fail(); return }
    this.expiry = setTimeout(() => {
      if (performance.now() >= this.deadline) this.fail()
      else this.arm()
    }, remaining)
    this.expiry.unref()
  }

  private challenge() {
    if (this.stop.signal.aborted || this.pending) return
    this.pending = true
    this.dirty = false
    const sentAt = performance.now()
    const nonce = crypto.randomUUID()
    // A pending renewal cannot extend the previous grant. The first request
    // has its own deadline even if the source never answers at all.
    if (!this.deadline) { this.deadline = sentAt + MAX_AUTHORITY_MS; this.arm() }
    void Promise.resolve().then(() => this.source({runId:this.runId,nonce},this.stop.signal)).then(grant => {
      if (this.stop.signal.aborted) return
      const now = performance.now()
      if (!grant || now >= this.deadline || now >= sentAt + MAX_AUTHORITY_MS || grant.nonce !== nonce || grant.runId !== this.runId
        || grant.live !== true || !Number.isFinite(grant.validForMs) || grant.validForMs <= 0) { this.fail(); return }
      const deadline = sentAt + Math.min(MAX_AUTHORITY_MS,grant.validForMs)
      if (deadline <= now) { this.fail(); return }
      this.deadline = deadline
      this.granted = true
      this.resolveReady(true)
      this.arm()
    }).catch(() => this.fail()).finally(() => {
      this.pending = false
      if (this.stop.signal.aborted) return
      if (this.dirty) { this.challenge(); return }
      this.next = setTimeout(() => this.challenge(),CHALLENGE_INTERVAL_MS)
      this.next.unref()
    })
  }
}
