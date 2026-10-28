import { createHash } from 'node:crypto'

// Historical names remain in schema_migrations. These aliases only recognize
// SQL verified byte-for-byte in #247 and active #316; no ledger row is forged.
export const MIGRATION_HISTORY = {
  "20261028213120_run_dispatch_keys.sql": {
    "aliases": [
      "20261025051201_run_dispatch_keys.sql",
      "20261026190325_run_dispatch_keys.sql"
    ],
    "sha256": "ae4618bb7a9e9bfd9df1b52df5b36a6cead6b87edf5dd271eff4b4ca5b9ebf9d"
  },
  "20261028213121_factory_192_stages.sql": {
    "aliases": [
      "20261025051202_factory_192_stages.sql",
      "20261026190326_factory_192_stages.sql"
    ],
    "sha256": "675eb386f3ef611885c145051806e2c5d3a9c07a37bde1eed9b0285cf48ef5ea"
  },
  "20261028213122_factory_194_approvals.sql": {
    "aliases": [
      "20261025051203_factory_194_approvals.sql",
      "20261026190327_factory_194_approvals.sql"
    ],
    "sha256": "9e5b437d465a41b4bd86c7818c1a0bf5dbbf986d10199bde3a67eefcad2b7a96"
  },
  "20261028213123_factory_195_monitor.sql": {
    "aliases": [
      "20261025051204_factory_195_monitor.sql",
      "20261026190328_factory_195_monitor.sql"
    ],
    "sha256": "83c6454347229177133868a975054f5abc699bbfdc66ac0eee873f202cdb7acf"
  },
  "20261028213124_factory_192_questions.sql": {
    "aliases": [
      "20261025051205_factory_192_questions.sql",
      "20261026190329_factory_192_questions.sql"
    ],
    "sha256": "b29263653731169ae347c840f8d0a0ec5cfaa586c0016043e1de9ffc9d9fe40d"
  },
  "20261028213125_self_improvement.sql": {
    "aliases": [
      "20261025070600_self_improvement.sql",
      "20261026190330_self_improvement.sql"
    ],
    "sha256": "5e9bad53e922a3256d239c65c8ea287a267e10a4537ff1c40b0b447137b5c2d5"
  },
  "20261028213126_improvement_skill_assignments.sql": {
    "aliases": [
      "20261025083303_improvement_skill_assignments.sql",
      "20261026190331_improvement_skill_assignments.sql"
    ],
    "sha256": "8022d8244ffdbee4cda8e8080e245353a40691367edb977085e6f5acef153928"
  }
}

export function alreadyApplied(name, applied, sql) {
  const historical = MIGRATION_HISTORY[name]
  if (historical && (typeof sql !== 'string' || createHash('sha256').update(sql).digest('hex') !== historical.sha256))
    throw new Error(`migrate: equivalent migration content changed: ${name}`)
  return applied.has(name) || (historical?.aliases ?? []).some(alias => applied.has(alias))
}
