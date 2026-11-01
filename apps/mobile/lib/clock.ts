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
  if (days === 1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** When a scheduled task runs next: "08:12" today, "明天 08:12", else "11月3日 08:12". */
export function nextWhen(iso: string) {
  const d = new Date(iso)
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000)
  if (days <= 0) return clockTime(iso)
  return `${days === 1 ? '明天' : `${d.getMonth() + 1}月${d.getDate()}日`} ${clockTime(iso)}`
}
