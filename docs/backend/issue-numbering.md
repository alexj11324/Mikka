# Issue numbers and read-path locking (#560, #499 A12)

The home/issue list previously called `ensureIssueNumbers` when an issue lacked
its number. That allocator locked the owner and every owned issue, so a page
read could wait on unrelated writes and participate in a deadlock. Creation
used the same owner-wide scan. Occurrence 6/10 × impact 5/10 = 30: #560 records
11 observed CI failures; a controlled local PostgreSQL reproduction held one
unrelated issue row and the old allocator hit lock timeout SQLSTATE `55P03`.

## Current behavior

- Lists never backfill numbers or take issue row locks. Detail reads no longer
  backfill either. Existing single-row privacy fences on detail/history reads
  remain in place.
- `allocateIssueNumbers` increments `user.lastIssueNumber` in the creation
  transaction. Rollback restores the counter. It does not read or lock existing
  issues; the owner-row update is compatible with foreign-key key-share locks.
- `issues.number` is generated from the existing JSON metadata. The unique
  `(userId, number)` index enforces per-owner uniqueness without changing the
  public identifier format or assigning new numbers to already numbered tasks.
- Migration `20261031000250_issue_number_counter_expand.sql` backfills historical
  missing numbers once and seeds each owner's counter from their maximum. The
  compatibility trigger keeps the counter current for old numbered writers.
  `20261031000251_issue_owner_number_unique.sql` builds the unique index
  concurrently. Existing duplicate numbers fail that build rather than silently
  renumbering tasks.
- Relation edits retain their existing owner advisory lock for graph consistency,
  but lock only source/target rows in ID order. Other graph nodes use an ordinary
  MVCC read. This keeps transitive parent/duplicate/block cycle checks correct,
  including concurrent edits on disjoint pairs, without locking unrelated tasks.
  The unrelated-row regression has occurrence 6/10 × impact 5/10 = 30.

## Relationship to the earlier counter work

The allocator and SQL reuse #499's implementation from #516/#524. Those changes
were not in main when #560 was reported. This delivery also removes read-time
backfills rather than retaining #516's reduced backfill on page reads. A9/A11
of #499 were already merged; this completes its remaining A12.

The SQL bytes from #524 are unchanged; migration timestamps follow current main's
migration ordering rule. SHA-pinned aliases recognize the prior #516/#524 names
on databases that already ran them. When integrating the remaining parts of
#524, retain these canonical migrations and do not restore `ensureIssueNumbers`.
No other portion of #524 is included here.

## Verification

Cloud Linux, isolated local PostgreSQL 17. `tests/issue-numbering.db.test.ts`
runs actual list actions in a read-only transaction; while the list transaction
remains open, another connection immediately locks the issues with `FOR UPDATE
NOWAIT` and actual relation edits complete. Missing numbers and the owner
counter remain unchanged across reads. It also covers concurrent allocations,
rollback, existing issue-row lock independence, migration replay/backfill,
compatibility with old writers and database uniqueness.

`lib/issue-relation-cycle.db.test.ts` covers edits alongside an unrelated held
row and concurrent disjoint edits that would jointly form a cycle. Existing
privacy, visibility and run-chain suites remain required; their fixtures use
unique per-owner numbers without weakening the new index or assertions.
