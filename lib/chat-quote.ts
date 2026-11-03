// A part of an earlier message the person quotes rides at the head of their message as Markdown quote lines, the
// format the phone app already sends (apps/mobile/components/ui.tsx), so the Coordinator, a thread's agent and every
// client read the same text:
//   > 先把首页截图放大
//
//   要整宽还是半宽？

/** The longest quote kept: a selection is cut here, with an ellipsis. */
export const REPLY_QUOTE_MAX = 1000

/** A selection as it is quoted: lines trimmed, runs of blank lines folded, cut to `REPLY_QUOTE_MAX`. */
export function quotable(selection: string): string {
  const text = selection.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > REPLY_QUOTE_MAX ? `${text.slice(0, REPLY_QUOTE_MAX).trimEnd()}…` : text
}

/** The message with the quote in front, one `> ` line per line of it. */
export function withReplyQuote(text: string, quote: string | null | undefined): string {
  const quoted = quote?.trim()
  if (!quoted) return text
  return `${quoted.split('\n').map(line => line ? `> ${line}` : '>').join('\n')}\n\n${text}`
}

/** A message that starts with quote lines: the quote and the words after it; otherwise no quote and the message. */
export function splitReplyQuote(message: string): { quote: string | null; text: string } {
  const lines = message.split('\n')
  let end = 0
  while (end < lines.length && lines[end].startsWith('>')) end++
  if (!end) return { quote: null, text: message }
  const quote = lines.slice(0, end).map(line => line.replace(/^>\s?/, '')).join('\n').trim()
  const text = lines.slice(end).join('\n').trim()
  // Only quote lines and nothing after: the person wrote a Markdown quote, not a reply to one.
  if (!quote || !text) return { quote: null, text: message }
  return { quote, text }
}
