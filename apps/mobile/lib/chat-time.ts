import { clockTime } from './clock'
import { mobileLocale, mobileMessages } from './messages'

/** A new time separator when this long has passed since the message before it (Alex 2026-11-08). */
export const SEPARATOR_GAP_MS = 15 * 60_000

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const weekdayFormat = new Intl.DateTimeFormat('en', { weekday: 'long' })
const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
const yearFormat = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' })
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/**
 * A chat's time separator, in the phone's time zone: 「09:21」 today, 「昨天 21:04」, 「星期五 14:11」 within the past
 * week, 「11月3日 14:11」 before that, with the year when it is not this year.
 */
export function separatorLabel(iso: string, now = new Date()) {
  const d = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  const time = clockTime(iso)
  if (days <= 0) return time
  if (days === 1) return `${mobileMessages.MobileCore.yesterday} ${time}`
  if (days < 7) return `${mobileLocale === 'zh-CN' ? WEEKDAYS[d.getDay()] : weekdayFormat.format(d)} ${time}`
  if (mobileLocale !== 'zh-CN') return `${(d.getFullYear() === now.getFullYear() ? dateFormat : yearFormat).format(d)} ${time}`
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

/**
 * Whether a message starts a new group under its own separator: the first one, one 15 minutes or more after the
 * message before it, or one on another day. Messages close together share the one separator above them.
 */
export function startsGroup(iso: string, previous: string | null | undefined) {
  if (!previous) return true
  const at = new Date(iso), before = new Date(previous)
  if (Number.isNaN(at.getTime()) || Number.isNaN(before.getTime())) return !Number.isNaN(at.getTime()) && Number.isNaN(before.getTime())
  return at.getTime() - before.getTime() >= SEPARATOR_GAP_MS || startOfDay(at) !== startOfDay(before)
}
