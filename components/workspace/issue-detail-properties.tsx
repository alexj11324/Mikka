/** Same rule as the board card (R-25): an open task whose due day has passed. */
export function overdue(dueDate: string, status: string, now: Date) {
  if (['done', 'canceled', 'duplicate'].includes(status)) return false
  return dueDate < `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
