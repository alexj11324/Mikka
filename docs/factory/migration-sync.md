# Common Factory migration synchronization

The common-baseline maintainer owns naming. Workers change their validators/adapters; they merge the published common baseline and apply only the supplied filename compatibility commits. They do not independently rename shared SQL. The manifest names one SQL file and one ledger identity per component.

Current main snapshot: `7251bf2f703624a9c3c3f0fed7cb51b3a7bb93d5`, latest migration `20261025013400_run_checkpoints.sql`. Reserved ordering slots:

1. `20261025013401_run_dispatch_keys.sql` (#191; unchanged SQL).
2. `20261025013402_factory_192_stages.sql` (#192; unchanged SQL).
3. `20261025013403_factory_194_approvals.sql` (#194 filename-only compatibility; feature remains separate).
4. `20261025014500_factory_195_monitor.sql` (#195; retain current name).

#193 currently adds no migration. Both Factory base migrations precede the dependent approval/monitor tables. All new files remain later than main's latest tracked SQL. The normal check-migrations script still reads origin/main; no check is skipped or pinned to a stale ref.

If main gains another migration, the parent holds one integration synchronization point: refresh main once, collect the complete unexecuted batch manifest, reserve ordered slots after the new main latest, and publish a single replacement baseline plus filename-only compatibility commits. Workers report a shared-order CI blocker and wait for that baseline instead of selecting their own timestamps. Rerun unchanged-content hashes, normal migration policy/order checks, and fresh disposable PG bootstrap before the parent's same-version acceptance. A new main migration invalidates that synchronization point and requires one coordinated refresh, not separate worker renames.

Never rename an already applied real migration. This task has applied these candidate migrations only to disposable test databases. Real database ledger verification remains subject to the parent's existing authorization; no live Neon state is assumed or modified.
