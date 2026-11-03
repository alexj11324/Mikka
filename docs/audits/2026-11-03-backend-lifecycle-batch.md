# Backend lifecycle integration: #1104, #1106, #1107, #1108

This batch continues PR #1105 and incorporates the four paused backend branches. The owner authorized a single combined delivery. Chat quoting/copy changes are outside this batch.

## Confirmed blockers and remedies

| Failure path | Occurrence × impact | Remedy and evidence |
|---|---:|---|
| Coordinator, MCP and computer dispatch bypass Factory; successful execution has no independent review/verification or human handoff | 10 × 9 = 90 | Atomic route, queue, configure, freeze, bind and replay receipt. Host drives independent stages and bounded repair. Real-PG dispatch chain reaches approval and stops for a human. |
| A new thread naming a different repository short-circuits repository-move authorization | 8 × 8 = 64 | Incorporate #1106; replacement and repository selection are independently checked, while an ordinary continuation retains its repository. |
| Subscription dispatch guesses CLI models or sees only a truncated model list | 8 × 9 = 72 | Incorporate #1107; complete authorized catalogue and device-reported models. Unknown cloud capabilities fail before normal placement. Build probes exact template CLI catalogues and publishes them together with image IDs and worker hash. |
| Claude custom-spawn stderr never reaches the SDK callback; stdout result can arrive before stderr data | 8 × 8 = 64 | Capture bounded child stderr directly; drain the independent pipe briefly on error. Fixed failure classes and redaction remain. Subscription regression: 22 passing cases. Historical Acme cause remains unproven. |
| Verification output is accidentally committed or counted as task changes | 7 × 7 = 49 | Exclude `/.verify/` in the common Git exclude file; remove it only from the temporary snapshot index, including force-staged files; omit it from changed-file reports. |
| A real readonly prompt reads a binary Git file and emits NUL; PostgreSQL rejects the event and ordered delivery/heartbeat stops | 6 × 9 = 54 | Normalize actual NUL and malformed Unicode before storing JSONB, preserving sequencing and literal escaped text. Real-PG regression failed with 22P05 before the fix and passes afterward. |
| Criteria with text but no UUID disappear, making an otherwise valid independent check impossible to pass | 9 × 8 = 72 | Preserve text criteria, require identity or text and concrete evidence. Actual MCP handoff and daemon report tests cover it. |
| Readonly Factory policy denies native shell, preventing its required real verification command | 9 × 9 = 81 | Host-scoped `verify_command` MCP tool runs only the frozen command, or an explicitly enabled repository inference with basis. Its child receives no application/model credentials. The daemon still independently verifies and owns the receipt. |
| A repository without verifyCommand cannot even dispatch review/verification | 8 × 8 = 64 | Review can inspect independently; verification infers a command from repository configuration, records basis and runs it. If none exists, a typed human question persists the exact answer as verifyCommand. Model context answers cannot change settings. |
| A desktop/report task is forced through commit/PR merge acceptance | 8 × 9 = 72 | Explicit repository/report/deliverable candidate kinds; non-repository deliverables have no invented commit SHA. Independent observations plus a browser-session-bound human acceptance receipt replace GitHub merge only for report/deliverable candidates. |
| Independent cloud stages start from a stale Bot snapshot instead of the producing task filesystem | 8 × 9 = 72 | Park the completed stage before the next independent CLI adopts the task machine. A park failure ends the queued child visibly instead of stranding it. |
| Quota fallback queues a child but Factory still binds the old run; cloud quota continuation also passes a task-machine repo to the Bot queue | 6 × 9 = 54 | Reconcile validated frozen quota continuations, re-resolve the cloud repository on the Bot runtime, and start after adoption. Check continuations restart with a fresh session and the same candidate assignment. |

## Verification and rollout

All database fixtures use loopback PostgreSQL 17 in disposable `_e2e` databases. Provider boundary fixtures are labelled; they do not prove a real cloud model call. No browser tests run.

Completed targeted checks include the independent desktop acceptance flow (16), Factory check/recovery database suite (58), subscription diagnostics (22), binary event storage (12), template builder/publisher tests, type checks and lint. Final combined source/daemon/DB checks, immutable real-CLI acceptance, UI screenshots and production evidence are recorded below as they complete.

Release order is mandatory: build versioned images from a fixed commit; probe each built image; atomically publish the three public ready image IDs, matching worker hash and measured model catalogue; then deploy the web dispatch code. Confirm the deployment Git SHA and image/worker pair before production smoke runs. Use only the documented smoke owner's normal APIs, its own newly created fixtures and normal cleanup. No production fixture SQL writes or simulated OAuth grants.
