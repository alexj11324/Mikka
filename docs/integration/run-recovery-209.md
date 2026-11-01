# Independent run recovery (#209)

This change reuses the current run UUID, lease, retry chain and Coordinator
inbox. It adds no scheduler, execution epoch or feature flag.

## Behavior

- `GET /api/cron/run-recovery` uses the existing `CRON_SECRET` bearer and returns
  only `{ owners, failed }`, with `Cache-Control: no-store`. Each pass selects
  at most 100 owners with expired leased runs or offline queued retries and
  invokes the existing bounded per-owner reclaimer. One owner's failure does
  not prevent the remaining owners from being checked.
- The existing minute Worker must call this endpoint independently of app or
  device polling. With a healthy minute trigger and work within the pass limit,
  an expired lease is checked on the next tick plus request/database latency.
  This is not a measured production SLO or a claim about an unavailable Worker.
- Retry creation still uses an atomic status/lease CAS and preserves the
  three-total-attempt limit. STOP must also be absent at that CAS. Terminal
  transitions recheck lease expiry, and a pinned device still reaches the
  existing thirty-minute offline queue limit. STOP cannot cause a new takeover.
- The terminal state and its `run_finished` inbox event commit together. A
  worker interruption or cleanup error after commit cannot lose that notification.
  Existing durable wake recovery handles the committed event.
- A different device receives the repository checkpoint and a new harness
  session. The old local session ID is forwarded only to the same device.

## Checkpoint recovery

The existing checkpoint fields identify the base commit, uploaded patch, file
count and upload time. Migration
`20261030230201_checkpoint_recovery_availability.sql` adds the nullable
`run_checkpoints.unavailableReason` column. Deploy that server/schema before
releasing the updated daemon.

Returning to a clean tree uploads a real empty snapshot, replacing discarded
work. A compressed patch over the existing eight-MiB limit uploads an explicit
`too_large` marker instead of silently keeping an older patch. The closest
attempt's snapshot takes precedence over ancestors, and freshness uses the
server's upload timestamp, not a device-supplied clock.

Cross-device claims require an uploaded snapshot no older than thirty minutes
and without an unavailable marker. Missing or unusable snapshots block before
issuing a lease or worker credentials. A same-device retry may instead continue
its actual original worktree: the updated daemon sends
`x-mikka-recovery-worktree: 1` to declare it enforces
`requireWorktreeContinuation`. That header grants no additional authority.
Without a usable snapshot, the assignment requires the original worktree and
omits the snapshot; the daemon blocks if the worktree is missing. With a valid
snapshot, a missing worktree can use strict snapshot recovery. An older daemon
never receives an unavailable marker as recovered work or an instruction it
cannot enforce. Missing bases and patch conflicts also block before an adapter
starts.

Only tracked and untracked repository work is transferred. Ignored files,
repository-external files, environment/secrets, process memory and the old
harness session are not transferred. The retry prompt states these limits.
A checkpoint is the last uploaded snapshot; it does not promise zero lost work
since that snapshot. In-flight external effects and already-issued provider
credentials retain their provider-specific limits. This patch does not claim
universal cancellation or exactly-once external writes.

## Verification

Cloud Linux, PG17 at `127.0.0.1:55599/mikka_old209_e2e`, a newly created isolated
database containing all 146 migrations. Existing test databases and ledgers
were retained. No production resource, real provider credential or paid worker
was used, and no Worker was deployed.

- Real PostgreSQL recovery tests: eight passed, zero skipped. Ten concurrent
  scans create one retry; barriers prove STOP/lease-renewal races; pinned queue
  timeout, nearest-attempt precedence and terminal-event durability pass. A
  PostgreSQL trigger fails cleanup after commit and the completed run plus
  undelivered inbox event remain durable. Restoring the old CAS/queue behavior
  makes the three corresponding regression cases fail.
- Actual authenticated checkpoint route with real PostgreSQL: six passed,
  zero skipped. Device clock skew, oversize/clean replacement, expired leases,
  STOP during a blocked write and a valid other owner's refusal are covered.
  These invoke the real route handler with `Request`; they are not a claim of
  full Next HTTP acceptance.
- Claim boundary tests: fourteen passed, zero skipped, including rejection before
  any old-client assignment/token, same-device versus cross-device sessions,
  strict local continuation without a snapshot and missing cross-device state.
  Database/framework IO is explicit fixture IO in these boundary tests.
- Actual Git plus daemon supervisor tests: 46 passed. Real tracked, binary and
  untracked changes restore; clean snapshots, an actual patch over eight MiB and
  conflicting patches are exercised. Missing/stale/unavailable recovery never
  starts the mock adapter. The daemon is real code; its control server and
  execution harness are fixtures, not live CC/Codex or two remote machines.
- HTTP transport tests: 23 passed, including strict continuation declaration
  and assignment decoding. Removing the two recovery-mode guards makes both
  claim regressions fail and lets the missing-worktree daemon submit fresh work.
- Cron authentication tests: two passed. Retry policy tests: eleven passed.

Logs retained under `/tmp/mikka-old209-` include `setup.log`,
`before-fix-db.log`, `recovery-db-atomic.log`, `checkpoint-db-final.log`,
`claim-final.log`, `daemon-final-v2.log`, `cron-tests.log` and `retry-unit.log`.
The recovery-mode follow-up adds `claim-mode-final.log`, `daemon-mode.log`,
`git-mode-final.log`, `claim-mode-before.log` and `daemon-mode-before.log`.

Parent integration must register both new DB test files in one sequential
script and add the existing minute Worker call. A fixed-version full Next
acceptance run, two separately running authorized daemons with a controlled
network partition, native stop timing and a real provider result readback are
still required before closing #209.

## Risk triage

These are engineering estimates, not measured production frequencies:

| Concrete failure | Occurrence × impact | Evidence |
| --- | --- | --- |
| No owner polling means no lease recovery | 6 × 6 = 36 | Existing trigger sites; independent real-PG scan |
| STOP or renewed lease loses to a stale scanner snapshot | 3 × 7 = 21 | PostgreSQL lock barriers; old predicates fail |
| A pinned retry bypasses the queue deadline forever | 4 × 4 = 16 | Old `continue`; thirty-minute regression |
| A newer clean/oversize tree silently retains an older patch | 4 × 7 = 28 | Actual Git snapshots and persisted replacement |
| Terminal commit survives but its later notification is lost | 3 × 5 = 15 | Actual post-commit cleanup failure injection |
| A cross-device retry receives a local session from another machine | 7 × 5 = 35 | Actual claim-handler response boundary |
| An unusable snapshot blocks intact local work or a missing snapshot silently starts fresh work | 6 × 6 = 36 | Claim-handler mode matrix; actual Git worktree continuation and missing-worktree supervisor paths |
