# Durable Telegram reply targets in the existing Coordinator

This stack starts at #295 `25d3d1bade8075c3aed10544bbdb1f3cbaed0fc0`. It does not introduce a new Workflow, scheduler or standalone chat runtime. #295's actual remote resource and original wake SDK lanes are green; its shared main DB inventory remains a parent authentication-lane dependency. Main later advanced to `d27af39bd12e9b69b48af985cb859a0ff475f1db` with #297. A full merge was attempted, exposed 20 auth/API/visibility and related conflicts, then safely aborted without overwriting those owners. The small #297 port is separate and described in `297-resource-composition.md`.

## Change

Taking input merges its trusted Telegram destination into `coordinator_sessions.telegram_reply_pending`, keyed by captured workspace/thread/Telegram account. The watermark is the server-issued event sequence and original event ID. Failed turns retain it. A distinct later successful turn can recover it from PostgreSQL, including after a process restart; a pending destination from another workspace cannot ride along.

Each actual durable chunk step checks the original event owner, immutable workspace, source sequence, original Telegram target, current issue/workspace authorization and current account link. The authority read locks remain held through the send. A cached target-selection step cannot grant permission to a retry. Chat SDK PostgreSQL state reuses that held app transaction through an async query scope, avoiding another borrow from the bounded app pool; the real state adapter set/get/delete path is tested with a one-connection pool.

Cleanup runs only after all chunks return successfully. Its watermark CAS cannot remove a newer staged message. A failed send or revoked link retains pending state. Already acknowledged destinations cause a replay to skip sending. The existing per-chunk Workflow SDK replay remains; Telegram still has no provider idempotency key, so a send delivered before the SDK records completion can be duplicated. This change does not claim exactly-once external Telegram delivery.

An empty final answer is replaced with `没有生成回复，请再试一次` before its result checkpoint/publication, and that fallback is delivered to Telegram. The existing warning remains. A historical empty checkpoint gets a delivery fallback without mutating its immutable model outcome.

New authenticated Telegram input captures a real linked-issue workspace or its sole active membership. An ambiguous/inaccessible workspace is refused rather than creating a membership or guessing a legacy/background scope. The canonical quota and later effect fences still independently revalidate. No UI layout or private enterprise management adapter is added.

Pending targets are fulfilled on a subsequent successful Coordinator turn. There is no separate autonomous Telegram-only retry scheduler. The migration adds an empty pending array; it does not guess which historical unrecorded external sends completed. Historical uncertain deliveries and old two-argument SDK chunk inputs require R's cutover inventory/reconciliation; an old unfenced input fails closed.

## Migration

- File: `drizzle/20261026010000_coordinator_telegram_reply_targets.sql`
- Target: application `MIKKA_DATABASE_URL`
- SHA-256: `3f67e3d2155584a9d5a0bb970ff2901c0ebfa08ae392fc66c427c0d08d6fbddf`
- Adds one JSONB session field and its array constraint; no new grants, cron or provider resource.
- Only isolated local PostgreSQL has been migrated. Production migration/deployment remains unapproved and unexecuted; R is sole main integrator.

## Evidence and boundaries

`docs/evidence/294-telegram` retains the pre-fix reproduction on actual compiled source ad6d488, positive SDK source 9f72584, real PG suites and the failed first 120-round stress experiment. All model and Telegram HTTP is keyless loopback. Real code exercised: production Next build, installed Local World / WorkflowAgent, durable chunk replay, current inbox/quota/policy source gates, split application/workspace PostgreSQL and real process SIGKILL/restart. No live Telegram message, real model inference, OAuth/webhook sign-in or paid/cloud Workflow resource was used. The recording is actual terminal output, not a UI recording.

The positive SDK cases include empty fallback; a failed Telegram turn followed by actual Next SIGKILL and a distinct successful turn recovering its destination; a rejected second chunk retried without re-sending the first chunk or model; and SDK retries with a cached target-selection result rejected by the fresh account-link fence, with no false cleanup. Seven real PG checks also cover old ACK versus newer input, cross-workspace isolation, current member/link/source/owner authorization, ingress scope capture and one-connection Chat SDK state. Original wake (26) and resource/schedule model (15) suites passed.

#297 is a 120-model-round ceiling per generate/inbox batch, not a promise to complete 120 calls before another guard. The independent helper tests assert the 90/119 boundaries exactly. The first real Local World stress experiment reached 58 controlled sends in 44.1s, then failed before 120 under the unchanged 45s generate deadline; 116 admission units remained settled. That failure is preserved and is not reported as 120-round completion. The revised acceptance explicitly checks either a completed 120-round run with final tools disabled, or a stable recorded earlier deadline with fewer than 120 sends; a separate tight-budget case must stop before a third send. Deadlines and canonical budget are not increased or removed for acceptance.

Final exact-head CI and integrated main/browser validation are still required. #176/#179/#294 are not closed and this candidate is not a production acceptance claim.
