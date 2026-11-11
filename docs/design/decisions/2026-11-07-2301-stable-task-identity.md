# Task identifiers survive grouping, ownership lifecycle and external sync

- Date: 2026-11-07
- Source: Alex's implementation request for [#1687](https://github.com/alexj11324/Mikka/issues/1687), section C; coordinated with [#1503](https://github.com/alexj11324/Mikka/issues/1503).
- Rule: Workspace tenancy from [0231](2026-11-02-0231-workspace-is-the-tenant.md); [work domain model](2026-11-07-2300-work-domain-model.md).
- Replaces: recomputing an existing task's displayed identifier from its current Team key, Team number, owner email or personal prefix. Frozen Run and publication contracts remain authoritative.

## Decision

A Task has one immutable UUID and one issued Mikka identifier (`issuedIdentifier`).
The UUID remains its storage and URL identity. The issued identifier is its human
reference. Neither grants permission: every lookup still requires the task's
Workspace and the caller's current authorization.

Once issued, the identifier cannot be changed or cleared, including by a Team
rename, move, archive, removal, a personal-prefix change or a Linear toggle. The
database rejects changes. `metadata.number` remains the legacy owner's numeric
counter; clients must render the server's `identifier` instead of constructing
one from that counter and a current Team or profile.

### New tasks

New tasks in a shared workspace receive a Workspace prefix and a counter shared
by all creators. The default prefix is `W` followed by the first twelve uppercase
hexadecimal digits of the Workspace UUID. A unique-prefix collision uses all
thirty-two digits. Prefix lengths of thirteen or thirty-three cannot overlap a
Team key (at most twelve characters) or a personal prefix (four letters).

An APP database transaction reserves the Workspace number, inserts the Task,
and records its issued alias together. Concurrent creators cannot issue the
same number. A rolled-back creation rolls its counter reservation back too.
Exhaustion of JavaScript's safe integer range fails issuance rather than rounding
or reusing an identifier. Workspace names and slugs do not affect the prefix.

A new personal task receives the owner's resolved four-letter prefix and owner
number at creation. Existing prefix validation and the `TASK` fallback apply.
Two people can have the same personal prefix. Such identifiers require scoped
resolution; there is no global uniqueness claim for historical or personal IDs.

### Historical tasks

Preserve the available history in this order:

1. The earliest frozen publication identifier, if a publication exists.
2. The Team identifier and Team number captured by the migration, if the task
   used the shared presentation at that time.
3. The owner identifier captured before a later email or personal-prefix change.

All captured alternatives remain aliases. This is a compatibility backfill,
not a mass renumbering operation. The migration records whether the task used
the shared presentation so that a scope change before its first new-version
read cannot change which historical candidate wins.

Existing `run_publications.identifier`, `branch`, PR references, Run IDs, thread
chains and frozen execution definitions remain untouched. A previously published
branch is reused under its own receipt. Issuance does not authorize moving that
publication to another repository or branch.

Team aliases are captured at migration and on Team rename, task regrouping and
group removal. They have no Team foreign key and survive removal of the group.
Linear identifiers are separate external aliases; their old and new spellings
are retained when a binding changes or is removed. Keeping a Linear alias does
not enable sync or establish an external target's authorization.

## Resolution and collisions

Alias lookup requires an explicit Workspace. Both APP and WS candidates must
match the live APP task's exact Workspace and historical creator ID. A supplied
owner filter narrows that namespace; it never authorizes another creator's
content. Duplicate aliases across creators return `ambiguous`, not the first
row. Stale WS aliases for deleted APP tasks do not resolve.

After unique resolution, normal task ACLs still apply before content or search
results are returned. Task search supports the canonical identifier and saved
aliases. The old `ORV-<number>` / `MIK-<number>` numeric search fallback is retained
only when no real identifier resolves; an ambiguous real alias never falls back
to an unrelated numeric task.

## Split databases, deployment and quarantine

APP owns `issues.issuedIdentifier`, `task_identifier_aliases` and
`workspace_task_identifier_counters`. WS owns `mikka_task_identifier_aliases`.
The WS table retains Team history and is read through a bounded application
query. There is no cross-database join, foreign key, counter or two-phase commit.

Run both schema migrations, complete the existing Task Workspace ownership
backfill, then run `backfillTaskIdentifiers(application, workspace)` before
admitting the new application. The backfill uses bounded batches, exact tenant
and creator matches, deterministic APP row locking, and transactions. Repeating
or resuming it does not change issued identifiers. Fully migrated list reads
remain read-only and never reserve numbers. A narrow runtime fallback completes
an authorized pre-migration row; detail reads invoke that fallback before their
shared row lock to avoid lock-upgrade deadlocks.

Tasks whose Workspace is still unknown stay quarantined. A prefix, alias,
creator account or publication spelling is not evidence sufficient to establish
a tenant. The identity backfill skips these rows and does not make them visible.

Deleting a Task cascades its APP aliases. Team deletion retains Task aliases.
Deleting a Workspace removes its WS aliases and its APP counter through the
Workspace lifecycle. Account deletion retains aliases of retained shared Tasks;
an `ownerId` is provenance, not a reason to erase shared history.

## Rollback and verification

Keep issued identifiers, alias history and counters when rolling application
code back. A rollback version must continue reading `issuedIdentifier`; code
that reconstructs numbers from mutable Team/owner state is incompatible. Do not
drop the additive records, rewrite old publications or renumber tasks to make an
older binary work. Schema/data problems are fixed forward from the recorded
history. Batch transaction failures can be retried after resolving the failure.

`tests/task-identity.db.test.ts` exercises real, separate disposable APP and WS
databases: historical migration, Team rename/removal before first read, Linear
unbind, immutable IDs, cross-creator ambiguity, malformed owner aliases,
concurrent creation, counter rollback, migration replay, and publication
preservation. Unit tests cover client compatibility projections and parsing.
Passing these checks does not substitute for the coordinated production
acceptance of the existing Factory delivery flow.
