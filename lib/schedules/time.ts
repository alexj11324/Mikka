import { ScheduleError, type Definition } from './contract'
import { nextCron } from './cron'
import { resolveLocal, timezone, wall } from './wall-time'

export { dailyTimeRepeats, resolveLocal, timezone } from './wall-time'

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
  if (def.timing.kind === 'cron') return nextCron(def.timing.expression, zone, after)
  if (def.timing.kind === 'manual') return null
  const localNow = new Date(wall(Math.floor(now / 1000) * 1000, zone))
  const [hour, minute] = def.timing.time.split(':').map(Number)
  const start = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute)
  for (let day = 0; day < 370; day++) {
    const at = resolveLocal(start + day * 86400000, zone, def.timing.fold)
    if (at !== null && at > now) return new Date(at)
  }
  throw new ScheduleError('noNextExecution', 400)
}

/**
 * Whether a daily time occurs twice on some day of the coming year in this zone (the hour repeated when clocks go
 * back), so the person must choose the earlier or the later one: the editor never chooses for them.
 */
export function runsOnSchedule(def: Pick<Definition, 'timing'>): boolean {
  return def.timing.kind !== 'manual'
}

