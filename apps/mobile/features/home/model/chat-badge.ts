/** The mark on a chat avatar (#1408). A waiting mark outranks an unread count. */

export type WaitingMark = 'question' | 'approval' | 'takeover'

export type AvatarBadge = { kind: 'waiting'; mark: WaitingMark } | { kind: 'unread'; count: number }

export function avatarBadge(input: { waiting: WaitingMark | null; unread: number }): AvatarBadge | null {
  if (input.waiting) return { kind: 'waiting', mark: input.waiting }
  if (input.unread > 0) return { kind: 'unread', count: input.unread }
  return null
}

/** 100 and above read as 99+. */
export function formatUnread(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export function sumUnread(counts: readonly number[]): number {
  return counts.reduce((sum, count) => sum + Math.max(0, count), 0)
}

/** Spoken name of a waiting mark. */
export function waitingLabel(mark: WaitingMark): string {
  if (mark === 'question') return '等待回答'
  if (mark === 'approval') return '等待批准'
  return '等待接管'
}

/** The short mark drawn in the badge; the spoken name is waitingLabel. */
export function waitingGlyph(mark: WaitingMark): string {
  if (mark === 'question') return '问'
  if (mark === 'approval') return '批'
  return '管'
}
