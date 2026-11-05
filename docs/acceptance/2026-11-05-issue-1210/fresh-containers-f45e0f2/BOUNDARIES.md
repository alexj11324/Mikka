# PR 1217 integration boundary review

Reviewed 2026-11-05 UTC. This is a source integration review, not cloud or production acceptance.

- Existing PR head: `cccef174f7a4e604a820a4b61f8521e8cdba100b`.
- Incoming main: `40d03479ea8260b8934f609b84c7c9cb60a94b3c`.
- Actual common ancestor: `fc2d401bde7b3f567b1288b01accd6fdeb433d0c`.
- Read-only Git merge-tree returned conflict exit 1 and tree `94eb3461a2ec560471db088e85c45417847fd059`.
- Five content conflicts, each with one block. Normal history was deepened before finding the ancestor; no unrelated-history override was used.

## Exact conflict choices

| File | Overlap | Required resolution |
| --- | --- | --- |
| `lib/cloud-computer/thread-machines.ts` | Removed snapshot credential imports meet new question-receipt imports | Keep `factoryEventId` and `questionFingerprint`; do not restore the unreachable snapshot probe/scrub imports or implementation. Preserve the rest of main's question worker upgrade and run-list notifications. |
| `lib/computer/auto-runtime.ts` | Removed parent liveness import meets Bot-list notification | Keep `botListChanged`; do not restore `deviceIsOnline` or parent wake/heartbeat admission. Pure metadata task runtime registration remains. |
| `lib/computer/queue-run.ts` | Unified cloud target import meets list notification and obsolete Factory-only type | Keep `cloudTaskTarget` and `runListChanged`; do not restore the removed Factory-specific admission type, argument or helper. |
| `lib/factory/checks.ts` | Unified fresh/retained target imports meet run-list notification and obsolete Factory-only type | Keep both cloud target helpers and `runListChanged`. Fresh official-template capability stays separate from retained VM custody plus actual installed capability; local online/installed checks stay strict. |
| `lib/cloud-computer/thread-worker-logs.test.ts` | Existing empty authorized-query admission fixture meets the new version-verification scenario | Keep admission `rows: []` and `rowCount: 0`, plus main's `verify_worker` legacy-template fixture. Keep the full diagnostic/rollback/secret-canary assertions; no snapshot provider stub returns. |

## Non-conflicting behavior that must survive

Main's #1301 changes four files. Its `lockQuestionRuntimeUpgrade` helper and all call sites were read in full. The automatic merge retains the same task VM and child run; it does not create another question, VM, native session or answer receipt. It checks the persisted Owner answer or recovery receipt against the original run/session, current task request epoch, attempt, stage, candidate and frozen execution definition. It repeats currentness and custody checks before switching and before credential bootstrap. Concurrent claim, stop, lease takeover and workspace drift must keep the winning state untouched.

PR 1217's template lookup remains lazy. Reusing the exact retained session does not acquire a new current-template configuration dependency. Only actual creation or replacement needs a fresh official template. The deleted snapshot creation/fallback stays deleted; historical table cleanup elsewhere is preserved.

Main's post-COMMIT list notifications must remain on actual Bot/run writes. None of the conflict choices may restore a parent sandbox/running prerequisite or remove a new notification. The incoming seven #1302 deployment-control blobs are unrelated and must be preserved byte-for-byte.

## Risk and verification scope

The integration hazard is dropping a new ownership/receipt/stop fence or reviving the removed parent gate while resolving nearby imports. Likelihood 4/10, impact 8/10 (score 32): the concrete overlap is the same runtime start path used for fresh tasks and original-session question continuation. This is an integration risk, not evidence that the resolved candidate has a defect.

Necessary checks are the new question upgrade/rollback/drift PostgreSQL cases, fresh task/first-Bot admission, Factory fresh-versus-retained capability, provider fallback and targeted startup diagnostics, then type/lint and diff checks on the exact candidate. Results have not yet been obtained for this merge. Existing main test bodies should be retained rather than rewritten to match changed behavior. All database execution must use a new isolated loopback `_e2e` database; provider calls remain test doubles.

The public PR ref remains unchanged until root review. The required paid local-loop cloud leg and all three real production paths remain outstanding; source tests and CI cannot stand in for them. No model calls, production writes, OAuth, credential changes or provider publication are part of this integration.
