# Automatic migration IDs and per-file execution

- Date: 2026-11-11
- Source: Alex selected Rails-style automatic timestamps and a per-migration
  execution ledger in the conversation, then instructed “继续”.
- Rule: — (development process)
- Replaces: migration timestamp allocation in
  [2026-11-01-1440](2026-11-01-1440-dev-workflow-local-first.md), rule 6;
  coordinator allocation of rule IDs remains in force.

Generate SQL migration IDs from UTC automatically. Use the later of the current
clock and the latest locally known migration ID plus one second, with atomic
collision handling for concurrent processes and worktrees. Migration IDs do not
require coordinator assignment or reserved Agent ranges.

Keep the existing Node/SQL runner and each database's `schema_migrations` ledger.
The ledger records executed filenames individually; a lower-timestamp missing
migration still runs. Merging independent branches out of timestamp order does
not require renaming migrations. Dependencies still govern which SQL can safely
run first, so each change needs fresh-database and upgrade-path verification.

Preserve the names and bytes of merged or executed SQL. Keep historical aliases,
ID validation and transaction safeguards. Corrective changes use another
migration; actual duplicate IDs remain an error. Separate clones can generate
the same ID, so resolve an unexecuted collision with the generator before merge.

Commands and review steps live in
[development workflow § 6](../../dev-workflow.md#6-rule-ids-and-migrations).
