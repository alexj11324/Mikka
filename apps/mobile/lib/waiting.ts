/** How long the chat waits before the spinner says what it is waiting for (Figma 843:2 #1). */
export const WAIT_NOTICE_MS = 30_000

/** 「等待回复 · 1 分 12 秒」 once a reply has taken 30 seconds to start; before that the spinner alone. */
export function waitingLabel(since: number, now: number): string | null {
  const seconds = Math.floor((now - since) / 1000)
  if (seconds * 1000 < WAIT_NOTICE_MS) return null
  const minutes = Math.floor(seconds / 60)
  return `等待回复 · ${minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`}`
}
