# Task machines keep one owner-created filesystem snapshot and restore from it

- Date: 2026-11-10
- Source: P0 brief for thread-level cloud machine lifecycle and snapshot restore (2026-11-10), superseding the snapshot-cost assumption in [2026-11-01-1410](2026-11-01-1410-one-task-one-sandbox.md). No direct quote from Alex was available when this decision was recorded.
- Rule: —
- Replaces: the sentence "Per-task snapshots are not used: E2B documents no price or retention for them." in [2026-11-01-1410-one-task-one-sandbox](2026-11-01-1410-one-task-one-sandbox.md). The rest of that decision (one task, one sandbox; pause instead of kill; never share a machine across tasks) remains in force.

## Decision

A task's paused E2B sandbox is not guaranteed to exist forever: a person can
delete it, an account can lose it, and the provider does not promise paused
VM retention to Mikka. The task's worktree, agent sessions and worker still
need a recovery path that does not silently start from an empty template.

Each task machine may therefore keep **one** owner-created E2B filesystem
snapshot of its own latest parked state:

- The snapshot reference lives on the run's `thread_machines` row
  (`filesystemSnapshotId`, `snapshotOperationId`, `snapshotTakenAt`,
  `snapshotState`), never in `workspace_snapshots`. That legacy table is a
  per-owner/workspace template cache with a `(workspaceId, ownerId)` primary
  key and stays unchanged.
- A snapshot is taken only when a run parks **and its native process already
  acknowledged exit**. It is never taken while a native CLI may still be
  running, because a full image would freeze that process into the snapshot.
- Before the image is taken, every path in
  `packages/daemon/src/credential-globs.ts` is scrubbed: coding-CLI logins,
  GitHub credentials, run adapters, native brokers, and one-use
  bootstrap/anonymous handoffs. The stage's device token is revoked and
  committed before provider snapshot I/O, so the daemon's own
  `device.json`/`daemon.secret` in the image cannot authenticate. Those two
  files stay because they are the local identity a same-VM resume needs, and
  deleting them would break resume before registration mints a new token.
- Snapshot creation never fails a pause. A failed attempt leaves the machine
  `paused` with `snapshotState='failed'`; the next run parks and tries again.
  An ACK lost after the provider created the image is reconciled by listing
  the exact per-run snapshot name before a second image is ever requested.
- `state='restore'` is the only provisioning state that rebuilds a VM from a
  snapshot. It is entered only for the same task, owner, workspace,
  repository and template kind, from a queued run without a stop request or
  an active lease. Epoch and the provisioning lease fence the transition.
  No other task or owner can ever contribute, read or reuse the snapshot.
- A missing or invalid snapshot falls back to the official template with
  `snapshotState='unavailable'`; it never fails a wake merely because the
  image is gone. Restoring is a recovery path, not a correctness guarantee.
  After a successful restore the source image is marked stale
  (`snapshotState='failed'`, reference kept), so the next park takes a fresh
  image and only then deletes the source; the reference survives for cleanup
  if the machine is ended first. A resumed or adopted VM marks its parked
  image stale the same way: the live VM is newer than the image.
- Retention follows the machine: a newer snapshot supersedes and deletes the
  previous one for the same task, and retirement of the machine deletes its
  snapshot after the kill is acknowledged. Account cleanup deletes any
  remaining `filesystemSnapshotId` (and never a template `snapshotId`).

## Kill switch and cost

E2B documents no public price or retention period for snapshots. Taking them
is therefore opt-in: `MIKKA_THREAD_SNAPSHOTS=1` enables both taking and
restoring. With the variable unset, parking and provisioning behave exactly as
before and no snapshot is created. Operators can disable the feature by
unsetting it; existing snapshots are still deleted by the normal retirement
and account-cleanup paths.

## Not decided here

- Persistent volumes, shared disks or cross-task dependency caches.
- Snapshot branching/forking, changing official templates, or reusing a
  snapshot across tasks or owners.
- Any path that snapshots credentials or a live native process.

## Verification

- `lib/cloud-computer/thread-machine-snapshot.db.test.ts` covers one snapshot
  per park, lost-ACK reconcile, pause on snapshot failure, restore, stop
  during restore, cross-task/template refusal and resume-without-restore.
- `lib/account/cloud-cleanup.db.test.ts` covers deleting
  `filesystemSnapshotId` while never deleting a template `snapshotId`.
- Real E2B snapshot create/restore/delete is exercised by
  `scripts/e2b/thread-snapshot-acceptance.ts`; it requires `E2B_API_KEY` and
  is not part of the loopback CI suite.
