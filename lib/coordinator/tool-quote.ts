// Shared by the browser's tool details and the server's chat projection.
// Keep this display-only module independent of prompt and message-signing code.

/** The input fields that say in words what a call was asked to do, in the order the chat looks for them. */
export const QUOTE_KEYS = ['note', 'prompt', 'instruction', 'message', 'request', 'text', 'body'] as const
export const QUOTE_PREVIEW_CHARS = 1000

/** The whitespace a quote is trimmed of, the same set the compact projection's SQL trims (chat-projection.ts). */
export const QUOTE_SPACE = ' \\t\\n\\r\\f\\v'
const EDGE_SPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g

/** A call's words trimmed of edge whitespace, whole; nothing when empty or not text. */
export function quoteText(text: unknown): string | undefined {
  return typeof text === 'string' ? text.replace(EDGE_SPACE, '') || undefined : undefined
}

/** A quote as the chat may show it: trimmed, and cut with an ellipsis past QUOTE_PREVIEW_CHARS. */
export function quotePreview(text: unknown): string | undefined {
  const whole = quoteText(text)
  if (!whole) return undefined
  return whole.length > QUOTE_PREVIEW_CHARS ? `${whole.slice(0, QUOTE_PREVIEW_CHARS).trimEnd()}…` : whole
}

/** The first of QUOTE_KEYS a tool input holds as text, whole and trimmed: what the chat quotes. */
export function toolQuoteText(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  for (const key of QUOTE_KEYS) { const words = quoteText((input as Record<string, unknown>)[key]); if (words) return words }
  return undefined
}

/** A tool input's words as the chat's quote, cut past QUOTE_PREVIEW_CHARS. */
export function toolQuote(input: unknown): string | undefined {
  return quotePreview(toolQuoteText(input))
}
