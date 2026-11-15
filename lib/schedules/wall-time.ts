import { ScheduleError } from './contract'

/** Wall-clock arithmetic in an IANA zone, with no cron parser, so the 自动化 editor can share it with the server. */
export function timezone(value: string): string {
  if ((!value.includes('/') && !['UTC', 'GMT'].includes(value)) || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) throw new ScheduleError('invalidIanaTimezone', 400)
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone }
  catch (error) { throw new ScheduleError('invalidIanaTimezone', 400, { cause: error }) }
}
const formats = new Map<string, Intl.DateTimeFormat>()
export function wall(at: number, zone: string) {
  let format = formats.get(zone)
  if (!format) formats.set(zone, format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }))
  const parts = format.formatToParts(at)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
}
/** Resolve local time using actual zone offsets on either side of transitions.
 * Gap has zero candidates; a fold has two candidates and requires explicit policy. */
export function resolveLocal(local: number, zone: string, fold: 'earlier' | 'later' | 'reject'): number | null {
  const offsets = new Set<number>()
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = local + hours * 3600000
    offsets.add(wall(instant, zone) - instant)
  }
  const candidates = [...offsets].map(offset => local - offset).filter(at => wall(at, zone) === local).sort((a, b) => a - b)
  if (!candidates.length) return null
  if (candidates.length > 1 && fold === 'reject') throw new ScheduleError('ambiguousLocalTime', 400)
  return candidates[fold === 'later' ? candidates.length - 1 : 0]
}
export function dailyTimeRepeats(time: string, zoneName: string, from: Date): boolean {
  const zone = timezone(zoneName)
  const [hour, minute] = time.split(':').map(Number)
  const localNow = new Date(wall(Math.floor(from.getTime() / 1000) * 1000, zone))
  const start = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute)
  // Only a day whose offset changes can repeat a time; check the noon offsets first to skip the rest.
  const noonOffset = (day: number) => { const at = start + day * 86400000 + (12 - hour) * 3600000; return wall(at, zone) - at }
  for (let day = 0; day < 370; day++) {
    if (noonOffset(day) === noonOffset(day + 1)) continue
    for (const candidate of [day, day + 1]) {
      try { resolveLocal(start + candidate * 86400000, zone, 'reject') } catch (error) { if (error instanceof ScheduleError && error.code === 'ambiguousLocalTime') return true; throw error }
    }
  }
  return false
}

/** When a schedule runs on its own: manual-only schedules wait for 立即运行. */
