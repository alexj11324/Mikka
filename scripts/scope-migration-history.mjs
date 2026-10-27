import { createHash } from 'node:crypto'

// Immutable SQL identities from the retained c48748e candidate. schema_migrations
// stores names, not hashes: one historical name below had two committed bodies.
// It must never be accepted as proof that the final body was applied.
export const SCOPE_MIGRATION_IDENTITIES = [
  { name: '20261027183117_personal_scope_detachment.sql', old: '20261026220000_personal_scope_detachment.sql', sha256: '35571a392ba8fa4476d2c15b35e1caab076ea243778bd074814fc3cd2b98ac10', target: 'MIKKA_DATABASE_URL' },
  { name: '20261027183118_issue_scope_generation.sql', old: '20261026220100_issue_scope_generation.sql', sha256: 'fd602bfcef233b455036b6567355f4ea5337f3655dd77f2b3a13777c85fa9257', target: 'MIKKA_DATABASE_URL' },
  { name: '20261027183119_linear_publications.sql', old: '20261026220200_linear_publications.sql', sha256: '12a094cc1141543c449baa0c1b9ad7df0f3f38719483460fe2c2b6f61a5a3db6', target: 'MIKKA_DATABASE_URL' },
  { name: '20261027183120_explicit_workspace_scope.sql', old: '20261026223000_explicit_workspace_scope.sql', sha256: '0c4d4d3a4b70cffbb2322772d8d80c0e7b098cc80536555027fe2d4bf8ec1770', target: 'MIKKA_DATABASE_URL' },
  { name: '20261027183121_team_issue_creation_gate.sql', old: '20261026224000_team_issue_creation_gate.sql', sha256: 'aff3a09d121043595c9fd9543d857d965745a9a45d109208575aa6902ac5a200', target: 'MIKKA_DATABASE_URL' },
  { name: '20261027183122_team_issue_create_receipts.sql', old: '20261026224100_team_issue_create_receipts.sql', sha256: '8417e276c34ead32912ab2db4228a479ee70888228e8610b704fe776886c1dfd', target: 'DATABASE_URL' },
  { name: '20261027183123_require_verified_team_promotion.sql', old: '20261026224200_require_verified_team_promotion.sql', sha256: '1221dba4b87e81fbdb1118263000e47b47df959411243c0f74d0a4fb62d8f40a', target: 'MIKKA_DATABASE_URL',
    // 82ca3a7 lacked the final outbox claim revocation UPDATE; ec208ed added
    // it under the same old name. Even a later promotion ledger cannot prove
    // which body ran: the old runner would have skipped the modified file.
    ambiguousOldHashes: ['d028f6a1ecadd2240dcc95f0cc00b626f0d99d2d6fd0ce61953bc201359dbf1c', '1221dba4b87e81fbdb1118263000e47b47df959411243c0f74d0a4fb62d8f40a'] },
  { name: '20261027183124_team_issue_promotions.sql', old: '20261026224300_team_issue_promotions.sql', sha256: '1b144fe0e2f0c9b8a1592fac1f04821749290b1a2d91453cf5c08d74d3f953ec', target: 'MIKKA_DATABASE_URL' },
  { name: '20261027183125_team_issue_promotion_receipts.sql', old: '20261026224400_team_issue_promotion_receipts.sql', sha256: '46cd44923c9dc40a6872c5b5b06a42299d50864047943484aa7d90fd304f8ddc', target: 'DATABASE_URL' },
]

export const SCOPE_MIGRATION_EQUIVALENTS = Object.fromEntries(SCOPE_MIGRATION_IDENTITIES
  .filter(identity => !identity.ambiguousOldHashes).map(identity => [identity.name, [identity.old]]))

function checkedIdentity(name, sql) {
  const identity = SCOPE_MIGRATION_IDENTITIES.find(item => item.name === name)
  if (identity && (typeof sql !== 'string' || createHash('sha256').update(sql).digest('hex') !== identity.sha256))
    throw new Error(`migrate: scope migration content changed: ${name}`)
  return identity
}

export function scopeMigrationApplied(name, applied, sql) {
  const identity = checkedIdentity(name, sql)
  if (!identity) return undefined
  if (applied.has(name)) return true
  if (!applied.has(identity.old)) return false
  if (identity.ambiguousOldHashes)
    throw new Error(`migrate: ambiguous scope migration history: ${identity.old}; schema verification and an explicit repair plan are required`)
  return true
}

/** Only these nine hash-pinned files have an audited outer BEGIN/COMMIT.
 * Defer their final COMMIT until the ledger insert succeeds, so a lost result
 * can never leave new scope DDL committed without its identity. SQL sources
 * remain unchanged; this is not a general SQL transaction rewriter. */
export function scopeMigrationBeforeCommit(name, sql) {
  if (!checkedIdentity(name, sql)) return null
  if (!/\bcommit;\s*$/i.test(sql)) throw new Error(`migrate: missing scope transaction boundary: ${name}`)
  return sql.replace(/\bcommit;\s*$/i, '')
}

/** The candidate ships both application and workspace scope migrations. A
 * missing entire target must not disappear from a per-target history check. */
export function validateScopeMigrationSources(files) {
  const sources = new Map(files.map(file => [file.name, file.sql]))
  for (const identity of SCOPE_MIGRATION_IDENTITIES) {
    if (!sources.has(identity.name)) throw new Error(`migrate: scope migration source missing: ${identity.name}`)
    checkedIdentity(identity.name, sources.get(identity.name))
  }
}

/** Validate each target's complete scope history before any pending migration
 * SQL runs. Replaying an earlier CREATE OR REPLACE after a later gate would
 * downgrade its function, so a history with holes must not be auto-repaired.
 * This does not inspect the schema or attest to DDL committed without a ledger. */
export function validateScopeMigrationHistory(pending, applied) {
  const sources = new Map(pending.map(file => [file.name, file.sql]))
  const activeTargets = new Set(SCOPE_MIGRATION_IDENTITIES.filter(item => sources.has(item.name)).map(item => item.target))
  for (const target of activeTargets) {
    let firstMissing
    for (const identity of SCOPE_MIGRATION_IDENTITIES.filter(item => item.target === target)) {
      if (!sources.has(identity.name)) throw new Error(`migrate: scope migration source missing: ${identity.name}`)
      const done = scopeMigrationApplied(identity.name, applied, sources.get(identity.name))
      if (done && firstMissing) throw new Error(`migrate: scope migration history has a gap: ${firstMissing} before ${identity.name}`)
      if (!done) firstMissing ??= identity.name
    }
  }
}
