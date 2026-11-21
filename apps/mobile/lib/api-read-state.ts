/** A failed first read has no timestamp, but must recover when the person returns to the app. */
export function needsForegroundRead(loadedAt: number, failed: boolean, now: number, freshFor: number) {
  return failed || loadedAt === 0 || now - loadedAt >= freshFor
}

/** A private resource may intentionally use 404 when the caller no longer has access. */
export function withholdsCachedRead(status: number) {
  return status === 403 || status === 404
}
