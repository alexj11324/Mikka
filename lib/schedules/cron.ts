import { CronExpressionParser } from 'cron-parser'
import { ScheduleError } from './contract'

const FIELDS = 5
const MAX_LOOKAHEAD_MS = 370 * 24 * 60 * 60 * 1000

/** Five-field cron only: no seconds, macros, `L`, `W`, `#` or `?`.
 * `L` is allowed in the month name JUL and `W` in WED; the parser rejects
 * those letters anywhere else. */
function expression(value: string): string {
  const trimmed = value.trim()
  const fields = trimmed.split(/\s+/)
  const dayOfMonth = fields[2] ?? ''
  if (
    !trimmed ||
    trimmed.startsWith('@') ||
    fields.length !== FIELDS ||
    /[?#]/.test(trimmed) ||
    /[LW]/i.test(dayOfMonth) ||
    /L/i.test(fields[4] ?? '')
  ) {
    throw new ScheduleError('invalidCron', 400)
  }
  return trimmed
}

/** The first cron occurrence strictly after `after`, in the definition's IANA zone. */
export function nextCron(value: string, zone: string, after: Date): Date {
  const parsed = expression(value)
  try {
    const next = CronExpressionParser.parse(parsed, { tz: zone, currentDate: after }).next().toDate()
    if (!Number.isFinite(next.getTime()) || next.getTime() <= after.getTime()) throw new ScheduleError('invalidCron', 400)
    if (next.getTime() - after.getTime() > MAX_LOOKAHEAD_MS) throw new ScheduleError('noNextExecution', 400)
    return next
  } catch (error) {
    if (error instanceof ScheduleError) throw error
    throw new ScheduleError('invalidCron', 400)
  }
}
