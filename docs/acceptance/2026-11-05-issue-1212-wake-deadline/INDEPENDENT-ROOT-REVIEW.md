# Independent source and evidence review — #1294

Reviewed candidate `9f0529efe6fab31bcda2d0c4e738308a8cd49e58`, base `fc2d401bde7b3f567b1288b01accd6fdeb433d0c`, tree `28f979c9000bb263d42fd3e0e9c24bc2862d928f`.

I reviewed the complete recovery implementation, wake orchestration changes, six orchestration tests, the expanded 22-case PostgreSQL suite, the workflow and step entry points, the final integration delta, and the raw successful timer/restart evidence. The integration preserves all six owned source/test blobs; its package change retains main's tool-activity and chat-dedupe tests. This is an independent source/evidence review, not a claim that I personally reran the agent's complete suite.

## Findings resolved before this candidate

The stale-ticket cases exercise the actual PostgreSQL claim path rather than duplicating a predicate in the test. A ticket remains bound to the original owner/Bot and event scheduling versions. Replaced, consumed, replayed, background, and out-of-scope work does not become newly eligible just because an old timer fires.

I identified the sub-millisecond lease boundary risk during review: PostgreSQL timestamps can remain live after conversion to a JavaScript millisecond. Both new real-database precision cases failed on the prior candidate. The final query rounds the maximum live boundary upward in PostgreSQL, so a lease at `now + 1 microsecond` does not consume an attempt at the previous millisecond. The final suite reports 22/22, zero skips; the earlier failing results remain in the evidence.

The ticket is exposed only after a confirmed COMMIT. Workflow start failures with an unknown outcome are not retried as though they were known failures. The durable workflow carries the next ticket through its own loop rather than recursively creating workflows. Existing owner/Bot locking, the wake lease, attempt cap, and backoff remain authoritative.

The main #1288 startup-failure path still settles its own committed provisioning lease, performs cleanup and `afterRunEnded`, and then calls `wakeCoordinator`. This PR does not replace that authority or allow a recovery ticket to overtake a live Coordinator session.

## Evidence and its limits

The final integrated source reports Coordinator 347/347, recovery PostgreSQL 22/22, Workflow compilation 148 steps / 7 workflows, typecheck, full lint, and the actual PR diff check all passing. The complete logs and the initial clipped native response are both retained. The named isolated database was dropped and independently queried as absent; only the task's recorded processes were stopped.

The second Local World run `wrun_01M6MFN27BD7Y4B3YW0A6T28XS` records the original 90-second absolute deadline, durable wait, shutdown of both queue-owning processes, restart before that deadline, the same wait completing, the real SQL step, and a durable terminal `run_completed` event. It demonstrates timer persistence and actual compiled workflow/SQL wiring across a process restart. The intentionally nonexistent synthetic batch produces an obsolete result with zero events and attempts. It does not demonstrate a production claim or model execution. The first driver's premature exit is retained as a failed evidence attempt.

## Decision

No remaining source-level blocker found in this seven-file change. Keep #1294 as a draft until its exact-head CI and the issue body's production and one-hour comparison gates are satisfied. This review does not approve deployment or close #1212 D.

The minute sweep remains necessary for the producer COMMIT-to-start gap, uncertain Workflow starts, a database mutation whose Workflow step completion was not persisted, legacy null-Bot events, and interrupted Coordinator turns. Schedules and run recovery are outside this change. No reduction of the sweep frequency, full D completion, production egress saving, or three-model production acceptance is established by these local results.
