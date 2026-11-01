// The web's bot list reads rows through the same function (components/nav/bot-list.tsx).
import { chatPreview } from '../../../lib/agent-history'

/** What a row shows for a card that has no words. */
export const CARD_LINE = '[卡片]'

/**
 * A chat row's one plain line. A bot's line is already plain text from the
 * server (an empty one is a card with no words); a group's last message is
 * stored as written, so an OpenUI reply is read here, never shown as source.
 */
export function chatLine(row: { bot: { line: string | null } } | { group: { lastMessage: { body: string } | null } }): string | null {
  if ('bot' in row) return row.bot.line === '' ? CARD_LINE : row.bot.line
  const body = row.group.lastMessage?.body
  return body ? chatPreview(body) ?? CARD_LINE : null
}
