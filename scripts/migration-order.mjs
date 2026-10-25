// This baseline fills tables that predate the tracked SQL history. Its timestamp
// remains a normal migration ID, but it must run BEFORE 0001's issues FK.
// Keep the exception explicit: future timestamped migrations stay chronological.
export const APPLICATION_BASELINE = '20261023221259_application_baseline.sql'

export function orderMigrations(names) {
  const ordered = [...names].sort()
  if (!ordered.includes(APPLICATION_BASELINE)) throw new Error(`migrate: missing required baseline ${APPLICATION_BASELINE}`)
  return [APPLICATION_BASELINE, ...ordered.filter(name => name !== APPLICATION_BASELINE)]
}
