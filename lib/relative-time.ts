const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['minute', 1], ['hour', 60], ['day', 24 * 60], ['week', 7 * 24 * 60], ['month', 30 * 24 * 60], ['year', 365 * 24 * 60],
]

/**
 * 「3 小时前」 in the person's locale. Anything older than a year is a date.
 * The session table only refreshes daily, so callers passing session times
 * should treat a value under an hour as 「现在」.
 */
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (minutes < 1) return format.format(0, 'minute')
  let index = 0
  while (index < STEPS.length - 1 && minutes >= STEPS[index + 1][1]) index++
  const [unit, size] = STEPS[index]
  return format.format(-Math.round(minutes / size), unit)
}

/** 「今天」/「昨天」/「2026-10-20」 for the activity timeline's day headings. */
export function dayLabel(iso: string, locale: string, now = new Date()): string {
  const at = new Date(iso)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((start.getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (days === 0) return format.format(0, 'day')
  if (days === 1) return format.format(-1, 'day')
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(at)
}
