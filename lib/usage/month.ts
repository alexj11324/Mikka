// 用量 month handling (pure). Months are UTC calendar months, written YYYY-MM.
import { z } from 'zod'

export const usageMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

export function monthBounds(month: string): { start: Date; end: Date } {
  const [year, index] = usageMonth.parse(month).split('-').map(Number)
  return { start: new Date(Date.UTC(year, index - 1, 1)), end: new Date(Date.UTC(year, index, 1)) }
}

export const currentMonth = (now = new Date()) => now.toISOString().slice(0, 7)

/** The month picker's options: this month and the ones before it, newest first. */
export function recentMonths(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
}

/** Every day of the month as YYYY-MM-DD, so the chart has a bar slot for quiet days too. */
export function monthDays(month: string): string[] {
  const { start, end } = monthBounds(month)
  const days: string[] = []
  for (let at = start.getTime(); at < end.getTime(); at += 86_400_000) days.push(new Date(at).toISOString().slice(0, 10))
  return days
}
