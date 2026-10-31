# Audit and account-data closeout (#210, #213)

Base: `375d670937ca06c53e47f336870481d38520c1fe`, cloud Linux.
This report records component evidence; it does not close either broad issue.

## Audit export

The previous CSV export stopped after reaching its cap and returned an ordinary
array without saying that later pages were missing. On real PostgreSQL a
controlled 121-row workspace returned 100 rows with a cap of 100, silently
omitting 21. The updated path refuses an oversized export with
`auditExportLimitExceeded`/HTTP 413, before publishing a partial file or receipt.
Occurrence 6 × impact 6 = 36: a successful-looking partial security export
omits incident evidence. The before/after probe is retained in
`/tmp/mikka-audit-cap-before-after.log`.

An export now reads a repeatable-read snapshot while holding the current
workspace-admin membership lease. It records the preparation in the existing
allowlisted audit table. Its manifest contains exact record count, ordered
record digests, UTC bounds and expiry. A separate workspace-database receipt
anchors those digests independently of the application event rows. This is
verifiable snapshot integrity, not a signature or a claim that an administrator
with access to both databases cannot rewrite them.

The existing authenticated CSV download keeps its format and gains export-ID,
count and SHA-256 headers. `format=json` returns a manifest, events and explicit
`nextOffset`; `exportId`, `offset` and `limit` resume the same snapshot. New
events cannot shift that snapshot. Each page checks current admin membership,
tenant, fifteen-minute link expiry and the anchored row hashes. Modified or
missing rows and reordered receipt entries return `auditExportChanged`/409.
Ordinary members and other tenants remain denied. Snapshot expiry does not
choose a retention/deletion policy for historical audit data.

Local isolated target: PostgreSQL 17,
`127.0.0.1:55599/mikka_audit_closeout_e2e`, 155 migrations including the new
workspace-target receipt migration. Existing databases/ledgers were retained.

- Real PG snapshot/resume/denial/tamper/failure tests: 7/7, no skips,
  `/tmp/mikka-audit-export-db.log`.
- Existing real PG audit query regression: 3/3, no skips,
  `/tmp/mikka-audit-query-regression.log`.
- Actual route-function adapter with explicit auth/service fixtures: 3/3,
  `/tmp/mikka-audit-route-final.log`. This is not full Next/session acceptance.
- Audit event contract source tests: 12/12; root TypeScript, targeted lint and
  diff checks passed. A parent integration build/HTTP-account-pool run and
  Git-linked CI still need to cover the final merged revision.

## Remaining scope

The existing event catalogue and member/token/secret writers remain in use.
Complete current authentication/denial/Agent-event coverage, cross-database
delivery recovery and explicit retention/legal-hold configuration still need
their full issue evidence. No historical-data cleanup policy or legal period
has been invented. Snapshot integrity does not silently promise immutable
storage or prove that a pre-snapshot event was never changed.

Account deletion currently needs a durable phase journal: its application
database commits before the workspace transaction finishes, and failed object
cleanup is only logged. The next component will preserve deletion intent,
cross-database progress and pending objects so retries and restore replay do
not claim unfinished work succeeded. Real provider/backup exceptions must be
listed rather than reported as deleted.
