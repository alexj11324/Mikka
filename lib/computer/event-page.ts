export const COMPUTER_EVENT_PAGE_SIZE = 100
export type ComputerEventPage = { events: { id: string; data: unknown }[]; cursor: string; hasMore: boolean }

/** PostgreSQL bigint cursors stay strings, including beyond JS's safe integer range. */
export function computerEventCursor(value: unknown): string | null {
  return typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= BigInt('9223372036854775807') ? value : null
}

export function computerEventPage(value: unknown, after: string): ComputerEventPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const page = value as ComputerEventPage
  if (!Array.isArray(page.events) || page.events.length > COMPUTER_EVENT_PAGE_SIZE || typeof page.hasMore !== 'boolean' || !computerEventCursor(page.cursor)) return null
  let previous = after
  for (const event of page.events) {
    if (!event || !computerEventCursor(event.id) || BigInt(event.id) <= BigInt(previous)) return null
    previous = event.id
  }
  return page.cursor === previous && (!page.hasMore || page.events.length > 0) ? page : null
}
