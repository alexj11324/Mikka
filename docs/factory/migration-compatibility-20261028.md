# Candidate migration compatibility with current main

The earlier PG run replayed historical DROP statements in owned isolated
fixtures. Their execution was reported; object pre-state and row counts were
not captured. It cannot be treated as authorized acceptance. No replay or
cleanup may run again under the current retention-only scope. The test body
is blocked, teardown defaults to retain, and full CI was cancelled at build.
The source/hash/ledger logic below remains a candidate requiring safe validation.

The audit pins main `dd6d8d4febbfe56bba5671cc5302c20f8e0e533d`, whose last
migration is `20261028143921_approved_write_binding.sql`. None of the seven
#247 migration filenames occurs in that main tree; none has byte-identical SQL
under another main filename. Each is instead byte-identical to both #247
`a3aab96af7a406d85aa46e6a15314788dd2907b4` and #316
`4c1255dbbb81b6247a3b68b7d946d22a6e8030be`'s corresponding file.

The original [7251bf2 manifest](migration-manifest-7251bf2.json) remains a
historical record. The [current manifest](migration-manifest-dd6d8d4.json)
lists the seven canonical names, two audited historical name families and full
SQL SHA256 values. New names `20261028213120` through `20261028213126` put the
unchanged SQL after current main, preserving dispatch → stages → approval →
monitor → questions → feedback ledger → assignment ledger order. No existing
production ledger or database was read, rewritten or presumed migrated.

`scripts/migration-history.mjs` recognizes an old name only when a matching
`schema_migrations` record actually exists **in that migration's target** and
the canonical file's complete SQL matches the audited hash. Even an already
canonical record cannot hide changed bytes. A matching historical record skips
execution without inserting a canonical alias row, changing the old name or
changing its `appliedAt`. An empty ledger does not skip on table existence.
Other unverified obsolete names are not declared equivalent. The timestamp
validator and frozen legacy-file policy are unchanged.

The new source tests check all seven hashes, single-file identity, old-name
absence, both alias families, unrelated/empty ledgers, byte drift and ledger
immutability. The PG17 compatibility test loads all SQL from the pinned main
in its own ordering into fresh disposable databases, retaining data afterward.
It invokes the actual `scripts/migrate.mjs` runner and verifies:

- Fresh main executes exactly seven canonical migrations and replays cleanly.
- Both historical families and mixed ledgers come from actual SQL execution;
  the subsequent runner preserves their exact names, timestamps and rows.
- Records in a separate workspace database cannot suppress application SQL.
- Existing synthetic authentication user, issue and run values are unchanged.

Database creation and SQL are limited to the guarded loopback PG17 test
container. No credentials, production SQL, cleanup, merge or deployment are
performed. #316's active writer is unchanged. A full main integration must
merge these seven data entries with main's other historical equivalences;
this candidate must not replace that existing shared manifest wholesale.
