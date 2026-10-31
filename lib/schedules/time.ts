import { ScheduleError, type Definition } from './contract'

export function timezone(value: string): string {
  if ((!value.includes('/') && !['UTC', 'GMT'].includes(value)) || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) throw new ScheduleError('invalidIanaTimezone', 400)
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone }
  catch { throw new ScheduleError('invalidIanaTimezone', 400) }
}
function wall(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at)
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
export function nextTime(def: Definition, after: Date, creating = false): Date | null {
  const zone = timezone(def.timezone)
  const now = after.getTime()
  if (def.timing.kind === 'once') {
    const at = Date.parse(def.timing.at)
    if (at <= now) { if (creating) throw new ScheduleError('scheduleTimeMustBeFuture', 400); return null }
    return new Date(at)
  }
  if (def.timing.kind === 'interval') {
    const start = Date.parse(def.timing.start)
    if (creating && start <= now) throw new ScheduleError('scheduleTimeMustBeFuture', 400)
    const period = def.timing.minutes * 60000
    return new Date(start > now ? start : start + (Math.floor((now - start) / period) + 1) * period)
  }
  const localNow = new Date(wall(Math.floor(now / 1000) * 1000, zone))
  const [hour, minute] = def.timing.time.split(':').map(Number)
  const start = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute)
  for (let day = 0; day < 370; day++) {
    const at = resolveLocal(start + day * 86400000, zone, def.timing.fold)
    if (at !== null && at > now) return new Date(at)
  }
  throw new ScheduleError('noNextExecution', 400)
}
