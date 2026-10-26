// This baseline fills tables that predate the tracked SQL history. Its timestamp
// remains a normal migration ID, but it must run BEFORE 0001's issues FK.
// Keep the exception explicit: future timestamped migrations stay chronological.
export const APPLICATION_BASELINE = '20261023221259_application_baseline.sql'

export function orderMigrations(names) {
  const ordered = [...names].sort()
  if (!ordered.includes(APPLICATION_BASELINE)) throw new Error(`migrate: missing required baseline ${APPLICATION_BASELINE}`)
  return [APPLICATION_BASELINE, ...ordered.filter(name => name !== APPLICATION_BASELINE)]
}

// The same reviewed BYOS migrations were previously applied from two unmerged
// branches under different names. Preserve those historical ledger entries;
// do not re-run their SQL when the canonical mainline names arrive.
export const MIGRATION_EQUIVALENTS = {
  '20261027000100_byos_credential_publications.sql': ['20261024064200_byos_credential_publications.sql', '20261025141650_byos_credential_publications.sql'],
  '20261027000101_byos_bindings_oauth.sql': ['20261024080000_byos_bindings_oauth.sql', '20261025141651_byos_bindings_oauth.sql'],
  '20261027000102_byos_device_authorization.sql': ['20261024160000_byos_device_authorization.sql', '20261025141652_byos_device_authorization.sql'],
  '20261027000103_byos_access_and_cleanup.sql': ['20261024190000_byos_access_and_cleanup.sql', '20261025141653_byos_access_and_cleanup.sql'],
  '20261027000104_byos_native_runs.sql': ['20261024201500_byos_native_runs.sql', '20261025141654_byos_native_runs.sql'],
  '20261027000105_byos_enrollment_transfers.sql': ['20261024223000_byos_enrollment_transfers.sql', '20261025141655_byos_enrollment_transfers.sql'],
  '20261027000106_byos_enrollment_cleanup.sql': ['20261024230000_byos_enrollment_cleanup.sql', '20261025141656_byos_enrollment_cleanup.sql'],
}
export function alreadyApplied(name, applied) {
  return applied.has(name) || (MIGRATION_EQUIVALENTS[name] ?? []).some(alias => applied.has(alias))
}
