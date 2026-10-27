const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** "HH:MM" in the phone's time zone, shown when the chat is swiped (Figma 01b). */
export function clockTime(iso: string) {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "10月27日 星期二": the centred label that starts each day in a chat. */
export function dayLabel(iso: string) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`
}

/** "08:12" today, "昨天", else "10月25日": the time beside a 建议 row. */
export function shortWhen(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  if (days <= 0) return clockTime(iso)
  if (days === 1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
