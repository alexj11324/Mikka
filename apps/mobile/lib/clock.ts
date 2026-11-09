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
