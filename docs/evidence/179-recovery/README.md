# #269 follow-up: skip-decision corruption and failed-report starvation

Base under review remains frozen: #269 `49a150fe46d326c2d55b598a0230c4c7554e7dc9`.
This independent patch addresses the parent's two P2 findings without changing UI,
production cron, credentials, IAM or real providers.

Both bugs were reproduced on actual cloud-Linux PostgreSQL 17. The baseline
[before.log](before.log) shows all three skip task kinds becoming `succeeded` after
a real PG report failure; the controlled executor performed one real marker-table
write. It is an isolated PG execution probe, not a model/provider claim. The same
run demonstrates 30 denied reports starving the healthy report after three scans.
No real external effect was sent.

The regression fixture installs an actual PG `agent_turns` insertion fault using
a nontransactional sequence, so the first report transaction aborts and the next
attempt sees the same committed occurrence. New process-store instances and ten
concurrent scans exercise restart/replay boundaries. It also tests catch-up's
positive case and explicitly attempts to mutate the stored decision through PG.

`execution_decision` is separate from transient `error` and immutable by trigger.
Historical skip/error rows whose decision cannot be reconstructed become `review`,
which cannot execute automatically. Already completed historical effects cannot
be undone; none of this candidate has been deployed to production.

Failed reports use persisted `report_next_at`/`report_attempts`, exponential
60-second–6-hour backoff and an indexed ordering by next attempt. Revocation still
prevents publication. Concurrent losers cannot multiply a due attempt. The fixed
[actual run](after.log) / [original PTY](after.cast) verifies 32 denied workspace or
unavailable-chat rows before a healthy tenant, bounded fair scans of retained
rows, subsequent chat restoration, ten-way repeated scans and one report/event.
Synthetic PG rows remain retained. Current permission checks were not bypassed.

Run with a disposable loopback database ending in `179_recovery`:

```
SCHEDULE_RECOVERY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55479/mikka_179_recovery pnpm test:schedules:recovery
```

Apply both tracked schedule migrations first. The dedicated CI also runs this
case on fresh PG. #176 consumer recovery will be a separate stacked change.
