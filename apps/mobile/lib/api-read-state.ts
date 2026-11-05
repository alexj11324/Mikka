/** A failed first read has no timestamp, but must recover when the person returns to the app. */
export function needsForegroundRead(loadedAt: number, failed: boolean, now: number, freshFor: number) {
  return failed || loadedAt === 0 || now - loadedAt >= freshFor
}
