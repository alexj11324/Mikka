/** What a home-list avatar may show besides itself (#1408). A waiting mark outranks an unread count. */

export type WaitingMark = 'question' | 'approval' | 'takeover'

export type ChatMarkInput = { question: boolean; approval: boolean; takeover: boolean; unread: number }

/**
 * One mark for a bot. The person holding the computer (takeover) comes before an approval they
 * still have to give, which comes before a question. Unread is separate and never hides a mark.
 */
export function chatMark(input: ChatMarkInput): { waiting: WaitingMark | null; unread: number } {
  const waiting = input.takeover ? 'takeover' : input.approval ? 'approval' : input.question ? 'question' : null
  return { waiting, unread: Math.max(0, Math.floor(input.unread)) }
}
