import { mobileLocale, mobileMessages } from './messages'

const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })

/** "HH:MM" in the phone's time zone, shown when the chat is swiped (Figma 01b). */
export function clockTime(iso: string) {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "08:12" today, "昨天", else "10月25日": the time beside a 建议 row. */
export function shortWhen(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  if (days <= 0) return clockTime(iso)
  if (days === 1) return mobileMessages.MobileCore.yesterday
  return mobileLocale === 'zh-CN' ? `${d.getMonth() + 1}月${d.getDate()}日` : dateFormat.format(d)
}

/** When a scheduled task runs next: "08:12" today, "明天 08:12", else "11月3日 08:12". */
export function nextWhen(iso: string) {
  const d = new Date(iso)
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000)
  if (days <= 0) return clockTime(iso)
  const date = days === 1 ? mobileMessages.MobileCore.tomorrow : mobileLocale === 'zh-CN' ? `${d.getMonth() + 1}月${d.getDate()}日` : dateFormat.format(d)
  return `${date} ${clockTime(iso)}`
}

/**
 * How long ago, as Capy's activity log says it: 「刚刚」, 「5 分钟前」, 「3 小时前」, 「2 天前」; a month or more is its date.
 * A clock ahead of the phone's reads as now.
 */
export function agoWhen(iso: string, now = Date.now()) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  const words = mobileMessages.MobileCore.ago
  if (minutes < 1) return words.now
  if (minutes < 60) return words.minutes.replace('{count}', String(minutes))
  if (minutes < 24 * 60) return words.hours.replace('{count}', String(Math.floor(minutes / 60)))
  const days = Math.floor(minutes / (24 * 60))
  return days < 30 ? words.days.replace('{count}', String(days)) : shortWhen(iso)
}
