# List invalidation evidence for PR #1291

Related tracking issue: #1212. This packet records local/CI checks, not production acceptance or the required performance comparison.

## Exact source and integration

- Source commit: `c68fc0bc9ddea0ee59a5c33afd3735283a7e0542`.
- Source tree: `4a291d12049d0e9fc04d82ed1061cdae570229a8`.
- Parent: `5b1c72944453318b87ec562427a4d147a29f733c`, preserving the external Coordinator's pending-action expectation correction and its earlier normal main integration at `42840b2ceb403b942bec3f5b3b21ac0e0fdd3234`.
- The final two-file delta registers a terminal list invalidation inside `failUnclaimedCloudStart`'s actual transaction and adds its real PostgreSQL regression. It does not change startup admission, ownership, leases, stop rules, retained-machine protection or model selection.
- All 99 main-only files from the main/601 integration were compared by Git blob; none was overwritten. The 15 overlapping files were reviewed separately. The actual integration details are retained in `merge-preservation.json`.
- The repository's Coordinator subsequently squash-merged the reviewed source as `3adee90c742b045e0eebd5854eecc6ade1c84aae`. Deployment and production acceptance are separate from this packet.

## CI and targeted local checks

The ten workflows associated with exact `c68` completed successfully. The saved CI job metadata distinguishes success from expected conditional skips; no skipped gate is presented as executed.

The final terminal-writer regression first failed against the original product: the pre-existing durable completion event suppressed the list notification even though the run became terminal. With the minimal registration restored, the actual list PostgreSQL suite passed **12/12, zero skips** (including the parent test). It verifies normal and deduplicated events, exactly one committed invalidation, deferred COMMIT failure, terminal replay, and owner/workspace/claim/lease/stop/session-resume guards. The `session_resume` case is specifically the `requireSessionResume` flag, not a replacement for the existing retained-VM adoption fence tests.

Related local checks passed: the existing run-end suite **12/12**, startup/channel/chat-poll checks **58/58**, Workflow generation, the repository's `pnpm typecheck` (`tsrs --noEmit`), and lint/UI policy. An earlier direct `tsc` invocation used the wrong compiler command and failed; its original log is preserved, not counted as a successful gate.

## Full local suite: retained failures and diagnosis

These results must remain separate:

| Run | Result | Evidence boundary |
| --- | --- | --- |
| Original full suite on 5b plus the exact final two-file tree | 58 tests: 57 passed, 1 failed, 0 skipped | Every pending-action subtest passed. Its parent failed during `DROP DATABASE ... WITH (FORCE)` with PostgreSQL `42501`; cleanup exited before closing the HTTP receiver. The outer command later reached its 600-second platform limit. After one normal signal to the verified own child, the buffered original error became visible. |
| Isolated pending diagnostic copy | 8/8, 0 skips | Only phase logging was added; assertions and product code were unchanged. This is diagnostic evidence, not an unmodified-suite substitute. |
| Original concurrent nine-file matrix with that diagnostic copy | 58/58, 0 skips | Both database pools and the HTTP receiver closed normally. This demonstrates that the cleanup failure is not deterministic, not that it was fixed. |
| Exact c68 unmodified `pnpm test:live-db` | 59 reported tests: 57 passed, 1 failed, 1 cancelled, 0 skipped | All notification-context subtests passed; its parent failed at the same forced database-drop permission boundary. The bounded runner sent SIGTERM after 120 seconds. The extra cancelled entry represents the still-live file process. |

The local roles had only the task's necessary database-creation privileges, not superuser or `pg_signal_backend`. The error did not identify the backend role it could not terminate; no such identity is inferred here. Permissions were not expanded, assertions were not weakened, and shared PostgreSQL roles/settings were not changed. All recorded task-owned processes, residual databases and roles were then explicitly verified absent. The full original logs, stage traces and recovery receipts are included under `gates/`.

## Exact c68 local production build and 32 screenshots

A fresh `pnpm build` succeeded on the exact source. A new random task-only role and unique loopback `_e2e` database were used with the normal TestAccountPool registration/login flow. The application version endpoint was checked against the source SHA before browser capture.

The 32 original PNGs cover four list surfaces—task board, all threads, Bot/group navigation and team members/settings—across English/Chinese, 1440/390-pixel viewports, and light/dark themes. The capture recorded no page errors and no HTTP errors. The normal group-creation POST returned 201 and created zero group turns.

Task/run/message rows were explicit display fixtures. They do not prove actual model execution, a worker claim, cloud-container behavior, or production authorization. Locally no Device Gateway was configured: the authorized ticket endpoint returned a null transport URL. These images therefore show the degraded transport path; healthy connection, visibility and owner-isolation behaviors are covered by the separate real React/SWR/channel checks, not inferred from a screenshot.

The screenshot evidence audit checked the 33 raw files against the test harness's known credentials and cookies and passed. Fixture IDs were removed, the leased test pair was quarantined, the own server exited, and the own database and role were confirmed absent. See the final capture and runtime manifests.

The historical exact-601 archive is preserved separately, including its early fixture/driver failures. Those screenshots are not presented as c68 evidence. The c68 capture includes the main branch's newer chat/thread presentation changes.

## Post-merge status and remaining acceptance

The root agent independently checked the actual Web build/upload and Gateway deployment jobs: [Web deploy 41943748245](https://github.com/alexj11324/Mikka/actions/runs/41943748245) and [Device Gateway 41943748165](https://github.com/alexj11324/Mikka/actions/runs/41943748165) succeeded. At `2026-11-05T00:54:28.400Z`, its independent public HTTP check returned 200 and `build=3adee90c742b045e0eebd5854eecc6ade1c84aae`.

This is not a claim that every runtime was published. [E2B official runtime 41943748222](https://github.com/alexj11324/Mikka/actions/runs/41943748222) passed its test/check/validate stages but its publish job `126972061558` failed with `production_source_changed`; that separate release check remains under investigation. No retry was triggered by this evidence task.

Real production product acceptance and the performance comparison required by the tracking issue's current body remain separate work. These local display fixtures do not replace them or complete the whole tracking issue.
