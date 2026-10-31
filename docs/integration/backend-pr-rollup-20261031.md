# Backend PR rollup — 2026-10-31

The requested inventory was frozen at 2026-10-31 04:36:46 UTC. Only PRs created before 02:36:46 UTC were eligible. Frontend and mixed frontend implementation PRs remain with cc.

| Source PR | Reviewed head | Included backend behavior |
| --- | --- | --- |
| #486 | `098bdfe658a13ca8633d1b13345870295800ba93` | Standalone actor constraint validation; PG17 concurrent writer and invalid-row regressions |
| #565 | `fa78bb0658980f2890f7037db7dfafd3a1c93210` | Explicit saved execution settings, discovered model slots, offline wait and opt-in account quota fallback (#537) |
| #576 | `176ccd11f9dccfad3da7d9cdff75d21c226bfb6b` | Actual-cost billing, model admission, approved writes, scoped reads, Team Skills, audit export/retention, deletion recovery, Linear archive and release/ops fixes |

Frontend/mixed candidates left untouched: #567, #557, #556, #552, #549, #547, #546, #534, #533, #532, #530, #529, #483, #482, #481, #480, #478. Newer PRs #603, #602, #599, #596, #591 and #585 are outside the frozen cutoff.

## Integration decisions

- Preserve main's Coordinator hosted-model fallback when no subscription exists. An unavailable explicit subscription still refuses; a named Bot still requires its executor. Replacing this with the old #565 file would break every subscription-free Coordinator dispatch (occurrence 10, impact 8, score 80). Existing `lib/bot-model-selection.test.ts` covers the retained behavior.
- Preserve #598 personal plugins, MCP dependencies, migration and required DB test inventory; union the model-admission and ops suites into the CI list.
- Preserve the latest workspace navigation selectors; retain #486's test-only account input-value readiness fix. No production frontend implementation is included.
- #576's failed claim fixtures imported the real auth graph or rejected the newly added issue-access import. Stub that IO boundary in fixtures, preserve production task authorization, and exercise denial before claim/token/receipt creation. The quota fixture also isolates the new model-admission IO boundary while checking the exact model and owner/workspace scope.
- Retain ordinary Linear bidirectional sync's existing explicit default-off decision. Features completed by the source PRs otherwise retain their enabled defaults.

## Migration ordering

All incoming SQL files are new relative to main. Their names are advanced past main's `20261031040000_personal_plugins.sql`, preserving their relative order and SQL bodies. Existing migrations on main are unchanged. All exact filename references in tests/docs follow the rename.

| Source filename | Integrated filename |
| --- | --- |
| `20261030233501_validate_activity_actor_type.sql` | `20261031044135_validate_activity_actor_type.sql` |
| `20261030233502_validate_activity_actor_id.sql` | `20261031044136_validate_activity_actor_id.sql` |
| `20261031001500_explicit_execution.sql` | `20261031044137_explicit_execution.sql` |
| `20261031012940_workspace_model_admission.sql` | `20261031044138_workspace_model_admission.sql` |
| `20261031013401_audit_export_snapshots.sql` | `20261031044139_audit_export_snapshots.sql` |
| `20261031015301_account_deletion_jobs.sql` | `20261031044140_account_deletion_jobs.sql` |
| `20261031015302_workspace_deletion_guards.sql` | `20261031044141_workspace_deletion_guards.sql` |
| `20261031020440_team_skill_metadata.sql` | `20261031044142_team_skill_metadata.sql` |
| `20261031020703_audit_retention_policy.sql` | `20261031044143_audit_retention_policy.sql` |
| `20261031021420_archive_linear_on_personal_scope.sql` | `20261031044144_archive_linear_on_personal_scope.sql` |
| `20261031022001_ops_monitor_observations.sql` | `20261031044145_ops_monitor_observations.sql` |
| `20261031022004_account_deletion_warnings.sql` | `20261031044146_account_deletion_warnings.sql` |

The actor validations retain `migrate: no-transaction`; they add no new constraint or column and allow concurrent writers with PostgreSQL's validation lock. Other changes are additive tables/columns, metadata guards, or explicit execution-rule data conversion; failures remain visible to the deployment migrator. A data rollback for new execution settings must preserve explicit selections rather than recreating automatic choices. Additive schema can remain when reverting application code; do not drop audit/deletion guard evidence or immutable artifacts during a rollback.

## Verification and boundaries

Integration environment: cloud Linux, Node 24, pnpm 10.34.3, a task-owned ephemeral PostgreSQL 17 container on loopback, isolated `mikka_e2e`. Full migration bootstrap succeeded. Local check results and the final head's required CI/browser results are recorded in the PR.

This rollup does not claim live SaaS OAuth/native-provider, Team Skills browser, production legacy-data validation, or production disaster-recovery acceptance. #576's remaining acceptance requirements stay documented in its integration records. Superseding source PRs is not a blanket closure of their referenced issues. The standalone validation PR's production scan duration remains dependent on real table size and legacy rows; its fail-closed behavior and concurrent-writer test are retained.
