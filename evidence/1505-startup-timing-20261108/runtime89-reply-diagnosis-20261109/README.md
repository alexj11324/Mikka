# #1505 — runtime89 retained-record reply diagnosis

This diagnostic does not change the original failed release verdict and creates no formal performance samples. The original candidate identity remains awaiting its original reader's run/task receipt; the exact retained target passes all six bounded scope checks and marker binding.

## Actual result

The successful read-only transaction at 2026-11-09T09:01:23.307785Z returned all 48 contiguous retained chunks (10,581 stored bytes; 170 text bytes). Agent start is seq 5. The sole canonical submit input is seq 7: its summary is a string but has no requested marker, and no completed tool precedes it. The one successful tool result is seq 8. All 34 text chunks and the persisted report also lack the marker. The retained run succeeded with report source and finite finishedAt, but the exact historical observeChunks implementation still returns replyVerified=false and replyVerifiedAfterTool=false.

These facts support rejection of this retained execution. They do not establish why the model ignored the task, prove the exact original HTTP snapshot, prove a stream-loss bug, or pass the runtime/native/formal gates. No gate is weakened and no model was rerun.

## Operator failures and repair

The first workflow failed before jobs due to a job-env runner context mistake; no OIDC or SQL occurred. The first executing attempt preserved exit code 2 with no projection. The next attempt added only closed connection classifications and proved that the pool rejected statement_timeout as a startup parameter. The successful attempt removed duplicate PGOPTIONS; the SQL remained byte-identical, beginning READ ONLY / REPEATABLE READ and setting local statement (5s), lock (1s), and idle transaction (10s) limits before the bounded SELECT. The client remained limited to 15s with TLS. Failed attempts remain here unchanged.

Each original job log and artifact was downloaded once by root. The successful ZIP was read/CRC-checked once; an oversized base64 output frame required a local framing reread of the already-downloaded files, without another artifact download or ZIP extraction. SHA256 and byte counts match the runner receipt.

The operator was closed at commit 420b52565f5c01d0147e46fa29e9b98e0427e35d by setting its only job condition to false; run 42590859516 skipped without a runner. The artifact-only VM is verified stopped. Raw model text, tool bodies, credentials, and private DB projection are absent from these artifacts.

The stale REVIEW DRAFT comment in the historical collector is not an execution record. The manifest, actual run metadata, immutable commits and receipts record what really ran.
