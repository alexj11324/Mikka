import type { createFormatter, DateTimeFormatOptions } from 'next-intl'

type Formatter = Pick<ReturnType<typeof createFormatter>, 'dateTime'>

/**
 * Formats a calendar date (`YYYY-MM-DD`, such as a due date) as that same day.
 * A date has no time zone: reading it as a local midnight and formatting it in
 * another zone (next-intl's configured one, the server's on the first render)
 * lands on the day before or after. Pin both ends to UTC instead.
 */
export function formatDateOnly(format: Formatter, date: string, options: Omit<DateTimeFormatOptions, 'timeZone'>) {
  return format.dateTime(new Date(`${date}T00:00:00Z`), { ...options, timeZone: 'UTC' })
}
