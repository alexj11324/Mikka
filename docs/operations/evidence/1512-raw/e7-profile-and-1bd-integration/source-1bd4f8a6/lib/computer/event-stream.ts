import { subagentEventSchema } from '@mikka/protocol/subagent'
import { computerEventPage, type ComputerEventPage } from './event-page'
import { readBoundary } from '../swr/read-observer'
import type { SubagentUpdate } from '@/lib/subagents/login-needs'

export type ComputerEventRuntime = {
  page(cursor: string, signal: AbortSignal): Promise<unknown>
  visible(): boolean
  watchVisibility(changed: () => void): () => void
  invalidations(refresh: (after?: number) => Promise<void>): () => void
  stopped: AbortSignal
  later(callback: () => void, milliseconds: number): unknown
  cancel(timer: unknown): void
}

/** Shared by the existing owner/workspace live channel. Only a notification,
 * reconnect, foreground transition or failed-read retry fetches another page. */
export class ComputerEventFeed {
  private cursor = '0'
  private snapshot: ReadonlyMap<string, SubagentUpdate> = new Map()
  private listeners = new Set<() => void>()
  private detach: (() => void) | null = null
  private request: AbortController | null = null
  private draining: Promise<void> | null = null
  private retry: unknown = null
  private pending = false
  /** Null is a forced read; otherwise every pending boundary must be covered. */
  private pendingAfter: number | null = null
  private generation = 0
  private completedBegin: number | null = null
  constructor(private runtime: ComputerEventRuntime) {}

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (!this.detach && !this.runtime.stopped.aborted) {
      const unwatch = this.runtime.watchVisibility(() => {
        if (this.runtime.visible()) void this.refresh()
        else this.cancelRead()
      })
      const unsubscribe = this.runtime.invalidations(after => this.refresh(after))
      const stop = () => this.cancelRead()
      this.runtime.stopped.addEventListener('abort', stop, { once: true })
      this.detach = () => { unwatch(); unsubscribe(); this.runtime.stopped.removeEventListener('abort', stop) }
      void this.refresh()
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) { this.detach?.(); this.detach = null; this.cancelRead() }
    }
  }

  private active() { return this.listeners.size > 0 && this.runtime.visible() && !this.runtime.stopped.aborted }
  private cancelRetry() { if (this.retry !== null) this.runtime.cancel(this.retry); this.retry = null }
  private cancelRead() {
    this.generation++
    this.request?.abort(); this.request = null; this.draining = null
    this.pending = false; this.pendingAfter = null; this.completedBegin = null; this.cancelRetry()
  }
  private accept(page: ComputerEventPage) {
    const next = new Map(this.snapshot)
    let changed = false
    for (const event of page.events) {
      const parsed = subagentEventSchema.shape.data.safeParse(event.data)
      if (parsed.success) { next.set(parsed.data.subagentId, parsed.data); changed = true }
    }
    this.cursor = page.cursor
    if (changed) { this.snapshot = next; for (const listener of this.listeners) listener() }
  }

  refresh(after?: number): Promise<void> {
    if (!this.active()) return Promise.resolve()
    // Only a fully accepted wave in this generation can cover an older Live
    // obligation. Reusing it must not clear newer pending work or its retry.
    if (after !== undefined && this.completedBegin !== null && this.completedBegin > after) return this.draining ?? Promise.resolve()
    this.cancelRetry()
    if (!this.pending) this.pendingAfter = after ?? null
    else if (this.pendingAfter !== null) this.pendingAfter = after === undefined ? null : Math.max(this.pendingAfter, after)
    this.pending = true
    if (this.draining) return this.draining
    const generation = this.generation
    const request = new AbortController()
    this.request = request
    const current = () => generation === this.generation && !request.signal.aborted && this.active()
    this.draining = (async () => {
      while (this.pending && current()) {
        this.pending = false; this.pendingAfter = null
        const began = readBoundary()
        let hasMore = true
        while (hasMore && current()) {
          const value = await this.runtime.page(this.cursor, request.signal)
          if (!current()) return
          const page = computerEventPage(value, this.cursor)
          if (!page) throw new Error('Invalid computer event page')
          this.accept(page)
          hasMore = page.hasMore
        }
        if (current()) {
          this.completedBegin = began
          // A slow post-boundary wave can finish after its catch-up is queued.
          // It covers that obligation only now, after every page was accepted.
          if (this.pending && this.pendingAfter !== null && began > this.pendingAfter) {
            this.pending = false; this.pendingAfter = null
          }
        }
      }
    })().catch(() => {
      if (!current()) return
      // A live socket cannot repair a failed HTTP read. Retry slowly and only
      // while visible; a notification cancels this timer and fetches sooner.
      this.retry = this.runtime.later(() => { this.retry = null; void this.refresh() }, 60_000)
    }).finally(() => {
      if (generation !== this.generation) return
      this.request = null; this.draining = null
    })
    return this.draining
  }
}
