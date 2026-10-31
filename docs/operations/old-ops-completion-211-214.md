# Operations closeout follow-up — 2026-10-31

## Real restore evidence on current main

A complete run of the existing isolated drill passed on fixed source
`e5261087e69529a32dd3e3a3c6afb665379ef844` with an empty working-tree patch.
It used the existing PostgreSQL 17 service and four new ordinary, owned
nonproduction fixture databases. No container, cloud resource, identity or
plan was created; all earlier databases/evidence were retained. The local free
space remained above 300 MiB after the run.

The run verified two database inventories, two object payloads and hashes,
current deletion replay, survivor isolation, credential revocation, declined
approval and uncertain-operation quarantine. All eight refusal cases passed:
wrong independent manifest, different migration inventory, unavailable vault,
stale current deletion journal, corrupted or missing objects, pending deletion
journal and an already-existing restore target.

Observed local RPO was **957 ms** against the recorded 60-second objective;
restore-command RTO was **2,190 ms** against 120 seconds. These are this isolated
SQL fixture's measurements, not a production SLA or an actual application
HTTP-to-provider recovery measurement. Restored targets remain quarantined.
The test encryption key existed only in memory and was cleared after the run.

Private raw evidence is retained in `/tmp/mikka-ops-drill-CXT9SP`, with the
original invocation output at `/tmp/mikka-ops-current-complete-drill.log` and
bounded summary at `/tmp/mikka-ops-current-drill-summary.json`.

## Correct recovery does not rewrite failed history

Review of that completed drill found an acceptance defect: the injected run
had missed its start deadline, but the recovery step changed its `startedAt`
to one second after creation and called it succeeded. This erased the failed
dispatch from the 15-minute SLO denominator and made the remaining alert look
resolved. The old output is retained; its claim that every alert recovered is
**not** accepted as evidence of a healthy SLO window.

The drill now uses `repairDrillFaults` to stop only its owned abandoned run,
clear its lease, deliver the injected wake and fail only its known
never-invoked effect. It never fabricates an earlier start or changes a
terminal failed run into success. Fresh SQL observation must show the live
wake/lease/effect faults gone while the historical `dispatch-start` alert
remains active. The report records that windowed alert separately.

The real PostgreSQL regression uses that exact repair helper and the actual
collector. It exercises stale wake, expired running lease, unknown and stale
operations, overdue unreferenced cleanup, failed dispatch and failed due work.
It also verifies that background wakes, terminal-run leases, reserved effects,
referenced/future/deleted secret metadata and explicit skip decisions do not
become the wrong signal. The internal HTTP receiver sees firing, suppression,
live-fault recovery and later window recovery without tenant IDs or secret
names. A controlled later **as-of clock** verifies expiry of the SLO window;
it does not claim a real wall-clock detection or recovery latency measurement.

The patched full four-database drill was not run a second time merely to make
another copy of the same restored assets. Its unchanged restore-component
measurements above retain their original revision; the corrected repair and
collector behavior is proved by the new real PostgreSQL regression. It is not
relabeled as a new full-system restore run.

## Request-level 429 and privacy evidence

A real loopback HTTP component fixture now exercises the current request
logger with 200, 429 and thrown-handler 500 responses. The actual emitted
start/completion lines feed the existing request SLI calculation: all three
requests stay in the denominator, one is successful, and one is rate-limited.
The alert retains the failed request ratio. Authorization headers, cookies,
query values and exception text are absent from the log and metrics.

This uses a controlled HTTP response, not a real provider action. It does not
stand in for the original login → chat → dispatch → completion → provider
business-flow acceptance. Existing sink refusal/retry and unavailable-database
cases remain covered by their real internal HTTP/SQL tests.

## Original scope that remains unexecuted

- **#211:** business task/run/approval/file/receipt data produced through a
  real fixed Mikka application HTTP/tool flow across its two logical data
  domains. The present restore drill seeds controlled business rows through
  SQL. Co-locating those domains in one physical database is a valid current
  deployment topology and matches the ordinary isolated account adapter; two
  physical source databases are not an added acceptance requirement.
  The actual tool limitation is `validateTargets` in
  `scripts/ops/isolated-recovery.mjs`: it requires two different database names
  for both backup and restore. A read-only probe using the same owned target
  for both source roles fails with `recoveryDistinctDatabasesRequired` before
  SQL mutation, vault access or file creation. Thus the current backup tool
  does not yet support source aliases. Restore targets must remain newly
  isolated; no target guard or attestation was changed during this assessment.
- **#212:** the whole fixed-application key-flow baseline and original
  end-to-end provider/cleanup failure matrix. Current evidence establishes
  collector, logged HTTP response and restore components, plus the separately
  recorded deployed natural-minute observations. It does not establish the
  entire application incident workflow or actual provider calls.

These are precise original nonproduction acceptance gaps. They do not add
production PITR, cross-region resources, new IAM/KMS or external paging as
closure conditions. Owner-provided OAuth and the decision to skip our real
Slack/Notion writes remain unchanged. Neither issue is closed by this
component evidence alone.

## #214 upstream status

A fresh read-only registry check still reports sandbox-runtime latest
**0.0.81**, declaring Zod `^3.25.0`; Zod latest is **4.6.7**. The installed
0.0.80 sandbox configuration and decider client explicitly import `zod/v3`.
The earlier advisory/compatibility evidence in
[old-ops-followup-211-214.md](old-ops-followup-211-214.md) therefore still
applies. No new dependency artifact was installed, exception added, scanner
weakened or package published. The real main publish job's rejection remains
the authoritative release result, not a successful package delivery.
