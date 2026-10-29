// System notifications and the Dock/taskbar badge, independent of Electron so
// the dedupe and rate limits are unit-testable.

import { desktopBadgeCount, desktopNotification } from '@mikka/protocol/bridge'

export interface NotificationSink {
  isSupported(): boolean
  show(title: string, body: string, onClick: () => void): void
  setBadge(count: number): void
}

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 5
const MAX_REMEMBERED = 500

export class NotificationCenter {
  private readonly shown = new Set<string>()
  private recent: number[] = []

  constructor(
    private readonly sink: NotificationSink,
    private readonly deliver: (href: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** Shows one notification per `id`, at most five a minute. */
  show(raw: unknown): void {
    const notification = desktopNotification.parse(raw)
    if (this.shown.has(notification.id)) return
    if (!this.sink.isSupported()) return
    const now = this.now()
    this.recent = this.recent.filter(at => now - at < WINDOW_MS)
    if (this.recent.length >= MAX_PER_WINDOW) return
    this.recent.push(now)
    this.shown.add(notification.id)
    if (this.shown.size > MAX_REMEMBERED) {
      const oldest = this.shown.values().next().value
      if (oldest !== undefined) this.shown.delete(oldest)
    }
    this.sink.show(notification.title, notification.body, () => this.deliver(notification.href))
  }

  setBadge(raw: unknown): void {
    this.sink.setBadge(desktopBadgeCount.parse(raw))
  }
}
