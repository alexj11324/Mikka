# Real6655 final result: item 9 passed, item 10 failed

## Disposition

**Overall run failed. Item 9 remains passed; item 10 failed after the natural server watchdog stop.** Workflow [41759046100](https://github.com/alexj11324/Mikka/actions/runs/41759046100), job 126342049054, ran immutable application source `3362fb03ef8d5f963d55b9eacc36a51d58ad0686`, tree `7d5da89896e9d1726301d0dca66c6af3b72e1cdc`. A final read-only observation at 2026-11-04T03:11:44.687935+00:00 found the same HEAD and no tracked changes.

Driver run: `6655d16b-ce7e-44b7-8ef1-e9d6114f09e5`. The dispatcher completed at 2026-11-04T03:06:19.871Z with exit code 1 and `interrupted: false`. No passed-items or source-evidence success manifest exists. The earlier item 9 report and initial in-progress snapshot are retained as historical evidence; this final report supersedes the overall in-progress disposition.

## What item 10 actually observed

Task `0338f390-bb82-4173-a945-718db36de0a1`, request epoch `4267cf96-3d95-403d-834e-d2722c2aefbe`, original run `00a80708-dc92-40e0-b34c-712ba108bec8` used automatic unpinned placement. Its owned native process subtree was suspended at 2026-11-04T02:20:06.574Z; the real daemon and normal minute cron remained running. The last progress timestamp stayed 2026-11-04T02:20:04.608Z.

There are **46 recorded samples**. The largest observed device-heartbeat age was 16212 ms; the minimum remaining lease was 73649 ms. This was an online stalled execution, not an offline device. The dedicated test daemon used the existing `--stall-minutes 60` option to isolate the unchanged server 45-minute watchdog. The ordinary daemon default remained 10 minutes; the checkpoint recovery window remained 30 minutes. No production timing constant or SQL timestamp was changed.

The normal server watchdog recorded its stop at 2026-11-04T03:06:00.196Z, and the run's `stopRequestedAt` was 2026-11-04T03:06:00.198Z. Detection latency from last progress was **2755588 ms** (45 minutes 55.588 seconds), consistent with waiting for the next normal minute cron after the 45-minute threshold.

## Failure and independently observed recovery boundary

The original run ended at 03:06:02.845Z with `status=failed`, but its persisted `stopReason` was **`error`**, not the expected server-revoked-lease reason `device_lost`. Its report summary was:

> claude exited before the turn ended: Claude Code process exited with code 143

The driver failed at 2026-11-04T03:06:03.103Z with `AssertionError / ERR_ASSERTION`: the real daemon must acknowledge its server-revoked lease; actual `error`, expected `device_lost`. This is a concrete terminal-classification failure. The subsequent cleanup is not counted as watchdog success. The exact callback ordering and a narrow product correction are being investigated separately; this evidence is not rewritten by that follow-up.

Independent read-only PostgreSQL observations also found one actual recovery run, `d4e86a62-f770-4074-9e16-19db411760ee`, with `retryOf` pointing to the original and device `38c31111-87a5-4008-9136-c07e6c65642b`. Its normal claim was refused because the checkpoint was older than the unchanged thirty-minute window. It ended at 03:06:08.628Z as `stopped/blocked`, with `startedAt=null`. The Task retained the same epoch and ended `execute/blocked`, revision 6. Published records for this Task: **0**.

That is an observed controlled checkpoint refusal, not successful execution on B. The driver aborted before its final repeated-cron/idempotency and notification assertions, so those assertions are not claimed as passed.

## Cleanup and scope

The driver recorded cleanup method `owned-process-termination`, explicitly `countedAsWatchdogEvidence=false`. At 2026-11-04T03:08:42.545949+00:00, old wrapper PID 42259, application parent PID 42327 and A daemon PID 43185 were absent. No process command line or working directory matched the exact old acceptance directory; port 3112 was closed. The evidence collection itself did not stop, resume or start any process.

All database observations used READ ONLY transactions. Original sample timestamps, source-file SHA256 and companion Git blob identities are retained. No credentials, authentication sessions, private prompts, process environments or full process arguments were exported. No manual approval, private sweep, cron call, model request or extra Factory task was triggered during investigation.

The successful item 9 and this failed item 10 used real DeepSeek Flash and real local daemons with a disposable database, local synthetic GitHub and real bare Git. Neither is production fault injection, real GitHub acceptance, Cloud-to-device runtime acceptance, or official Claude/Codex subscription acceptance. A production source-tree match does not widen this scope.
