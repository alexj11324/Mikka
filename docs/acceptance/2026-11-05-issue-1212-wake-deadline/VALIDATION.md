# Coordinator wake deadlines — implementation and evidence

This is a partial #1212 D change. It adds durable deadlines for an already claimed inbox batch. It retains the existing minute sweep, 120-second wake lease, maximum eight attempts, and existing backoff. It has not been deployed or accepted in production.

## Source and integration

The original tested base is `ae56a432c94dcfb5d55ff1fe9b942dfa0d666260`; its seven-file implementation tree is `1b3040c790cdf1ff5d823f037d8d0479cdfd250d`.

A real three-way merge with `fc2d401bde7b3f567b1288b01accd6fdeb433d0c` produced final tree `28f979c9000bb263d42fd3e0e9c24bc2862d928f`. The only conflict was the existing `test:coordinator-events` command. The resolution keeps main's `tool-activity` and `chat-dedupe` tests and adds the wake-deadline test. All six owned source/test files are unchanged by integration. The final delta against main remains seven files, 477 insertions and 30 deletions.

The #1288 startup failure integration was reviewed semantically: `failUnclaimedCloudStart` persists the actual failure in its transaction, then performs cleanup and `afterRunEnded`, then calls the existing `wakeCoordinator`. This PR leaves those run/worker lease checks intact. An active Coordinator session still blocks the wake claim until its actual persisted expiry.

## Behavior

Each ticket contains only owner/Bot identifiers and exact event scheduling versions, never message content, credentials, or model configuration. A timer can claim only matching original rows under the same owner/Bot advisory lock. Consumed, background, replayed, replaced, or out-of-scope rows cannot become new work for a stale timer.

Both claim and failure tickets are returned only after confirmed COMMIT. A failed or uncertain Workflow start is not blindly retried. The workflow carries its next ticket through a durable `sleep(Date)` loop and never recursively starts another recovery workflow.

PostgreSQL can retain microseconds that its JavaScript Date parser discards. The blocking-lease query therefore rounds the real maximum lease boundary upward in SQL. A lease that SQL still considers live cannot disappear at an equal JavaScript millisecond.

## Verification

| Version | Actual gate | Result |
| --- | --- | --- |
| Old production module + four new stale-ticket cases | Real PostgreSQL | 8 passed / 5 failed including parent; all four intended new cases failed |
| First implementation | Same PostgreSQL cases | 13/13, no skips |
| Expanded first implementation | Real PostgreSQL | 20/20, no skips |
| Candidate before SQL rounding + two microsecond cases | Real PostgreSQL | 19 passed / 3 failed including parent; both microsecond cases failed |
| Corrected implementation | Real PostgreSQL | 22/22, no skips |
| Original implementation tree | Wake orchestration | 6/6, no model calls |
| Original implementation tree | Complete Coordinator command | 334/334, no skips |
| Original implementation tree | Complete bot-chats database command | 80/80, no skips |
| Original implementation tree | Workflow compilation | 148 steps / 7 workflows, exit 0 |
| Original implementation tree | Typecheck and full lint | Both exit 0 |
| Final fc2 integration | Complete Coordinator command | 347/347, no skips |
| Final fc2 integration | Wake database cases | 22/22, no skips |
| Final fc2 integration | Workflow compilation | 148 steps / 7 workflows, exit 0 |
| Final fc2 integration | Typecheck and full lint | Both exit 0 |
| Final delta against fc2 | `git diff --check` | Exit 0 |

The integrated Coordinator command first completed successfully with its stdout going to native command logs. The provider clipped that long string. The unmodified command was run once more with the whole command redirected to a file; its complete 347-test log is retained. The initial successful command and clipped native response are retained separately. The compiler's native stdout was short and complete. The inherited main whitespace warning is retained; it is absent from this PR's actual delta.

## Real Local World durable timer and restart proof

This uses the installed Workflow 5.2.3 / Local World 5.1.2 runtime and the real compiled workflow and database step. It uses only loopback HTTP and the isolated test database. There is no Owner login, production access, or model call.

The ticket deliberately references a missing synthetic inbox batch. At the deadline the actual database path returns `obsolete` and the workflow finishes. This demonstrates compiled timer, restart, and actual SQL wiring; the independent PostgreSQL tests prove claim, race, cap, COMMIT and precision behavior. These two forms of evidence are not a production end-to-end acceptance claim.

Successful run: `wrun_01M6MFN27BD7Y4B3YW0A6T28XS`.

| Observation | UTC timestamp |
| --- | --- |
| Original absolute deadline | 2026-11-04 23:54:03.309 |
| Original durable wait written | 2026-11-04 23:52:34.690 |
| Both first queue-owning processes stopped | 2026-11-04 23:52:34.859 |
| Restart ready, still before original deadline | 2026-11-04 23:52:46.063 |
| Same wait completed | 2026-11-04 23:54:03.780 |
| Actual recovery step completed | 2026-11-04 23:54:04.001 |
| Completed run observed | 2026-11-04 23:54:04.044 |

There is exactly one `wait_created` and one `wait_completed`, with the same correlation ID and original `resumeAt`. The final durable `run_completed` event is present. Before and after SQL counts for the synthetic owner/Bot are both zero events and zero attempts. Only this task's recorded Next/SDK process groups were stopped; no global process kill was used.

The first runtime attempt is preserved as a failure: its actual step completed, but the evidence driver exited its queue-owning SDK process as soon as the run projection said completed, before the terminal event had been persisted. The corrected driver waits for that real terminal event before exiting. Product source did not change for this correction. The early upload directory error, git identity preflight error, whitespace check, and all test RED results are also retained.

## Evidence locations and integrity

* `preintegration/`: original implementation, RED/GREEN tests, complete original gates, first runtime failure and its actual event files.
* `final-export/mikka-wake-integrated-packet/`: final seven-file full contents, Git blob/SHA-256 manifest, delta against fc2 and integration delta.
* `final-export/`: final gate files, actual successful runtime event/run/step files, merge logs and cleanup receipts.
* `runtime-proof/`: exact evidence drivers, including the original failing driver.
* `preintegration-command-receipts.json` and `integrated-native-log-receipts.json`: provider command completion metadata and original clipped response.

Archives were downloaded as ordered, bounded records and verified byte-for-byte:

* `preintegration.tar.gz`: 72,090 bytes, SHA-256 `2f7478d5601dd48436ecd5bde7df66a76cca982768859f6aab4ad916b5a6103b`.
* `final-export.tar.gz`: 141,028 bytes, SHA-256 `0047b603ea16f5031ba63a6b0c26323302aa8d15bfa1770285f6a7386097e01a`.

## Cleanup and remaining work

The only test database, `mikka_wake_deadline_20261104_e2e`, was dropped. PostgreSQL independently returned `absent: true` at `2026-11-04T23:58:28.278455Z`. The owned server/starter PIDs are absent. The shared Vercel session and other agents' databases/processes were not stopped.

The draft still needs its exact-head CI, production deployment/version verification, production acceptance and the issue body's measurement gates. The minute sweep remains necessary for producer COMMIT-to-start gaps, unknown/failed Workflow starts, a step lost after database mutation but before durable completion, old null-Bot events and interrupted Coordinator turns. Removing or slowing that scan, schedules and run recovery are outside this PR.
