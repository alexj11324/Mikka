/** A local calendar day as YYYY-MM-DD. */
export function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 新建任务's Due date shortcuts (Capy's Today / Tomorrow / End of this week / In one week), as local days from `now`.
 * The week ends on Sunday (ISO weeks); on a Sunday, End of this week is that day.
 */
export function dueDatePresets(now: Date) {
  const day = (offset: number) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset))
  return {
    today: day(0),
    tomorrow: day(1),
    endOfWeek: day((7 - now.getDay()) % 7),
    inOneWeek: day(7),
  } as const
}
