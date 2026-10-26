import { createHash } from 'node:crypto'

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
const EQUIVALENT_SQL_SHA256 = {
  '20261027000100_byos_credential_publications.sql': '1ec983216f55262ceaf1adbdafd191168a3e2ac552909f8c529eb04ad74865e3',
  '20261027000101_byos_bindings_oauth.sql': 'daa6b4adc31536f66b9cc56bb2c4142c834efc4c540e3073340b023dcd3839d8',
  '20261027000102_byos_device_authorization.sql': '6e4aa98f3efa36a48af3c0937b7eddd64bb1d03498c65cc92b48461dd7a0ce9f',
  '20261027000103_byos_access_and_cleanup.sql': '5f08ca8b2814f5539af0013f7ef927ab264c895007d7cbc766fdbb0055aaca6d',
  '20261027000104_byos_native_runs.sql': '8dd7726b41a89b602cf2b6e70217ab7a2374de4664a66b2ea4b7ea5c21bb3333',
  '20261027000105_byos_enrollment_transfers.sql': '8e8887e88e39c74f9e240d7bf125029a511817038ef9e787d5a2c97d741daf43',
  '20261027000106_byos_enrollment_cleanup.sql': '3c159f69bc6ed132b0289499e2ea71d240f0b7a0324caecca7a5b6b206cb6ea4',
}
export function alreadyApplied(name, applied, sql) {
  if (applied.has(name)) return true
  if (!(MIGRATION_EQUIVALENTS[name] ?? []).some(alias => applied.has(alias))) return false
  // An alias is safe only for the exact SQL historically recorded under it.
  if (typeof sql !== 'string' || createHash('sha256').update(sql).digest('hex') !== EQUIVALENT_SQL_SHA256[name])
    throw new Error(`migrate: equivalent migration content changed: ${name}`)
  return true
}
