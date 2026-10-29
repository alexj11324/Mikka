# Common Factory migration synchronization

The common-baseline maintainer owns naming. Workers change their validators/adapters; they merge the published common baseline and apply only the supplied filename compatibility commits. They do not independently rename shared SQL. The manifest names one SQL file and one ledger identity per component.

Current main snapshot: `8f8484ff3bf9a55f5c759d7e2316ab90c5fb854f`, latest migration `20261025043000_pending_actions.sql`. Reserved ordering slots:

1. `20261026190325_run_dispatch_keys.sql` (#191; unchanged SQL).
2. `20261026190326_factory_192_stages.sql` (#192; unchanged SQL).
3. `20261026190327_factory_194_approvals.sql` (#194 filename-only compatibility; feature remains separate).
4. `20261026190328_factory_195_monitor.sql` (#195; unchanged SQL).

#193 currently adds no migration. Both Factory base migrations precede the dependent approval/monitor tables. All new files remain later than main's latest tracked SQL. The normal check-migrations script still reads origin/main; no check is skipped or pinned to a stale ref.

If main gains another migration, the parent holds one integration synchronization point: refresh main once, collect the complete unexecuted batch manifest, reserve ordered slots after the new main latest, and publish a single replacement baseline plus filename-only compatibility commits. Workers report a shared-order CI blocker and wait for that baseline instead of selecting their own timestamps. Rerun unchanged-content hashes, normal migration policy/order checks, and fresh disposable PG bootstrap before the parent's same-version acceptance. A new main migration invalidates that synchronization point and requires one coordinated refresh, not separate worker renames.

Never rename an already applied real migration. This task has applied these candidate migrations only to disposable test databases. Real database ledger verification remains subject to the parent's existing authorization; no live Neon state is assumed or modified.

## Coordinated replacement on 2026-10-25

The parent appointed the #195 combined candidate as this batch’s naming owner. Only unmerged candidate migrations are renamed; prior execution was limited to disposable test databases. No real database migration or deployed ledger change is performed. SQL bytes remain identical, verified by SHA256.

| Component | Previous timestamp | Canonical timestamp |
| --- | --- | --- |
| 191 dispatch | 20261025013401 | 20261026190325 |
| 192 stages | 20261025013402 | 20261026190326 |
| 194 approvals | 20261025013403 | 20261026190327 |
| 195 monitor | 20261025014500 | 20261026190328 |
| 192 questions (integrated) | 20261025040500 | 20261026190329 |

The verified questions increment now occupies the reserved slot with its original SQL content. Other workers adopt this mapping instead of choosing fresh names. The manifest retains its original filename for downstream consumers; its main snapshot and contents are updated.

## 2026-10-26 acceptance integration

Current main `ba6a0c96` requires unpublished migrations after its latest migration. The five shared Factory migrations now use `20261026190325` through `20261026190329`; their SQL bytes and manifest hashes are unchanged. The unpublished Skill assignment migration moved from `20261025083303_improvement_skill_assignments.sql` to `20261026190331_improvement_skill_assignments.sql`, after `20261026190330_self_improvement.sql`, because it references the base proposal table and immutable-row trigger function. No applied migration ledger is rewritten.
