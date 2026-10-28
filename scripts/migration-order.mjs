import { createHash } from 'node:crypto'

// This baseline fills tables that predate the tracked SQL history. Its timestamp
// remains a normal migration ID, but it must run BEFORE 0001's issues FK.
// Keep the exception explicit: future timestamped migrations stay chronological.
export const APPLICATION_BASELINE = '20261023221259_application_baseline.sql'
export const ARTIFACT_COMPATIBILITY = '20261027164500_artifact_legacy_compat.sql'
const MAIN_ARTIFACTS = '20261027010100_artifacts.sql'

export function orderMigrations(names) {
  const ordered = [...names].sort()
  if (!ordered.includes(APPLICATION_BASELINE)) throw new Error(`migrate: missing required baseline ${APPLICATION_BASELINE}`)
  const remaining = ordered.filter(name => name !== APPLICATION_BASELINE && name !== ARTIFACT_COMPATIBILITY)
  // A legacy production table predates main's artifact migration. The
  // compatibility migration only renames that known legacy layout and must
  // therefore run before the mainline create statements.
  if (ordered.includes(ARTIFACT_COMPATIBILITY)) {
    const artifactIndex = remaining.indexOf(MAIN_ARTIFACTS)
    remaining.splice(artifactIndex < 0 ? remaining.length : artifactIndex, 0, ARTIFACT_COMPATIBILITY)
  }
  return [APPLICATION_BASELINE, ...remaining]
}

// Earlier branch and deployment names are aliases only for identical SQL.
export const MIGRATION_EQUIVALENTS = {
  '20261028202036_device_authorization.sql': ['20261028022909_device_authorization.sql'],
  '20261028143922_local_repository_defaults.sql': ['20261028020000_local_repository_defaults.sql'],
  '20261028143921_approved_write_binding.sql': ['20261028133236_approved_write_binding.sql', '20261027182632_approved_write_binding.sql'],
  '20261028143920_operation_ledger.sql': ['20261028133235_operation_ledger.sql', '20261027182631_operation_ledger.sql'],
  '20261027181000_agent_kit.sql': ['20261027040500_agent_kit.sql'],
  '20261027164500_artifact_legacy_compat.sql': ['20261027040459_artifact_legacy_compat.sql'],
  '20261027164501_cloud_computers.sql': ['20261027040500_cloud_computers.sql', '20261026235901_cloud_computers.sql'],
  '20261027164502_computer_run_bindings.sql': ['20261027040501_computer_run_bindings.sql', '20261027000000_computer_run_bindings.sql'],
  '20261027164503_byos_credential_publications.sql': ['20261027040502_byos_credential_publications.sql', '20261027000100_byos_credential_publications.sql', '20261024064200_byos_credential_publications.sql', '20261025141650_byos_credential_publications.sql'],
  '20261027164504_byos_bindings_oauth.sql': ['20261027040503_byos_bindings_oauth.sql', '20261027000101_byos_bindings_oauth.sql', '20261024080000_byos_bindings_oauth.sql', '20261025141651_byos_bindings_oauth.sql'],
  '20261027164505_byos_device_authorization.sql': ['20261027040504_byos_device_authorization.sql', '20261027000102_byos_device_authorization.sql', '20261024160000_byos_device_authorization.sql', '20261025141652_byos_device_authorization.sql'],
  '20261027164506_byos_access_and_cleanup.sql': ['20261027040505_byos_access_and_cleanup.sql', '20261027000103_byos_access_and_cleanup.sql', '20261024190000_byos_access_and_cleanup.sql', '20261025141653_byos_access_and_cleanup.sql'],
  '20261027164507_byos_native_runs.sql': ['20261027040506_byos_native_runs.sql', '20261027000104_byos_native_runs.sql', '20261024201500_byos_native_runs.sql', '20261025141654_byos_native_runs.sql'],
  '20261027164508_byos_enrollment_transfers.sql': ['20261027040507_byos_enrollment_transfers.sql', '20261027000105_byos_enrollment_transfers.sql', '20261024223000_byos_enrollment_transfers.sql', '20261025141655_byos_enrollment_transfers.sql'],
  '20261027164509_byos_enrollment_cleanup.sql': ['20261027040508_byos_enrollment_cleanup.sql', '20261027000106_byos_enrollment_cleanup.sql', '20261024230000_byos_enrollment_cleanup.sql', '20261025141656_byos_enrollment_cleanup.sql'],
  '20261027164510_local_computer_reviews.sql': ['20261027040509_local_computer_reviews.sql', '20261027000200_local_computer_reviews.sql'],
  '20261027164511_cloud_device_scope.sql': ['20261027040510_cloud_device_scope.sql', '20261027000300_cloud_device_scope.sql'],
  '20261027164512_cloud_worker_leases.sql': ['20261027040511_cloud_worker_leases.sql', '20261027000400_cloud_worker_leases.sql'],
  '20261027164513_computer_run_approvals.sql': ['20261027040512_computer_run_approvals.sql', '20261027000500_computer_run_approvals.sql'],
  '20261027164514_bot_cloud_runtimes.sql': ['20261027040513_bot_cloud_runtimes.sql', '20261027000600_bot_cloud_runtimes.sql'],
  '20261027164515_workspace_computer_policy.sql': ['20261027040514_workspace_computer_policy.sql', '20261027000700_workspace_computer_policy.sql'],
}
const EQUIVALENT_SQL_SHA256 = {
  '20261028202036_device_authorization.sql': 'b04be21d6641914e55113464452d2d4d4b83a767df4bf9b7a7b5b3471c52e414',
  '20261028143922_local_repository_defaults.sql': '904b822ef1a281e1fb294ce1a25c3237e5493703ef61bb88c20628954093226a',
  '20261028143921_approved_write_binding.sql': '60fc01efb736fd5614d2a51f779f9a2fbe6f78f3f3ce0b4f99b8b8240ac48f90',
  '20261028143920_operation_ledger.sql': 'f5fbfacc61d5417aeacce88460244f185ec8a76a4784bddd151d006b48c627df',
  '20261027181000_agent_kit.sql': '365230faab874af93a8f696a1f83f1b3276a83bb6ea933b3939a6b654dea1be2',
  '20261027164500_artifact_legacy_compat.sql': 'e82a90aec2a61675877e8fb12d66ac62d02ae4fbdcd174d543b82e03a2fc49a8',
  '20261027164501_cloud_computers.sql': '018c0fbf7941f607b42e02c1d56bdeebef38ab9717ef9a84bce9df7f173ffe65',
  '20261027164502_computer_run_bindings.sql': 'fbb9384171873aeb0762481e09d35051cd7adc09569332e8594ecfb459cffaf5',
  '20261027164503_byos_credential_publications.sql': '1ec983216f55262ceaf1adbdafd191168a3e2ac552909f8c529eb04ad74865e3',
  '20261027164504_byos_bindings_oauth.sql': 'daa6b4adc31536f66b9cc56bb2c4142c834efc4c540e3073340b023dcd3839d8',
  '20261027164505_byos_device_authorization.sql': '6e4aa98f3efa36a48af3c0937b7eddd64bb1d03498c65cc92b48461dd7a0ce9f',
  '20261027164506_byos_access_and_cleanup.sql': '5f08ca8b2814f5539af0013f7ef927ab264c895007d7cbc766fdbb0055aaca6d',
  '20261027164507_byos_native_runs.sql': '8dd7726b41a89b602cf2b6e70217ab7a2374de4664a66b2ea4b7ea5c21bb3333',
  '20261027164508_byos_enrollment_transfers.sql': '8e8887e88e39c74f9e240d7bf125029a511817038ef9e787d5a2c97d741daf43',
  '20261027164509_byos_enrollment_cleanup.sql': '3c159f69bc6ed132b0289499e2ea71d240f0b7a0324caecca7a5b6b206cb6ea4',
  '20261027164510_local_computer_reviews.sql': 'f213d360b2b130a9536b33bf1eb8646fd83824415f8839fb77513b4115abb85b',
  '20261027164511_cloud_device_scope.sql': '889bb9ffabc776a3df8dc4caef13e6fdfcb615d8ec84f89d00672a9c3c40d3bd',
  '20261027164512_cloud_worker_leases.sql': '24fc7695775eb37d350de4ab08c8e425c95161468c7e65e4ac823d84e638ceb3',
  '20261027164513_computer_run_approvals.sql': 'c9164c3b066dff4c0d6fa0566bbca028e6b8df8974cd10f8982256721de58f80',
  '20261027164514_bot_cloud_runtimes.sql': '2b752bada07de7569781d8f4f5bfd3200179c16c831f212cd81964c22259d4e7',
  '20261027164515_workspace_computer_policy.sql': 'b776298be218ee6f741347df61c99ada1565d92d813aa7da396725a3a967c76e',
}
export function alreadyApplied(name, applied, sql) {
  if (applied.has(name)) return true
  if (!(MIGRATION_EQUIVALENTS[name] ?? []).some(alias => applied.has(alias))) return false
  // An alias is safe only for the exact SQL historically recorded under it.
  if (typeof sql !== 'string' || createHash('sha256').update(sql).digest('hex') !== EQUIVALENT_SQL_SHA256[name])
    throw new Error(`migrate: equivalent migration content changed: ${name}`)
  return true
}
