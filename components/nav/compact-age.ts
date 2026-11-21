/** How long ago, in one short word, as Capy's sidebar shows it (`now`, `45s`, `12m`, `3h`, `2d`, `1w`, `1y`); the units are the person's language's. */
export type AgeWords = (key: 'now' | 's' | 'm' | 'h' | 'd' | 'w' | 'y', values?: { n: number }) => string

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR, WEEK = 7 * DAY, YEAR = 365 * DAY

export function compactAge(at: string | null | undefined, now: number, words: AgeWords): string {
  if (!at) return ''
  const elapsed = Math.abs(now - Date.parse(at))
  if (!Number.isFinite(elapsed)) return ''
  if (elapsed < 5 * SECOND) return words('now')
  if (elapsed < MINUTE) return words('s', { n: Math.floor(elapsed / SECOND) })
  if (elapsed < HOUR) return words('m', { n: Math.floor(elapsed / MINUTE) })
  if (elapsed < DAY) return words('h', { n: Math.floor(elapsed / HOUR) })
  if (elapsed < WEEK) return words('d', { n: Math.floor(elapsed / DAY) })
  if (elapsed < YEAR) return words('w', { n: Math.floor(elapsed / WEEK) })
  return words('y', { n: Math.floor(elapsed / YEAR) })
}
