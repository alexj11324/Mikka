# Thread settings

P2 of #2956 uses the P1 registry and typed value tables. No new field-specific migration is needed.

The inherited `protectManualThreadTitles` and `keepPinnedThreadsActive` defaults are both true, preserving the existing behavior. The first controls automatic renaming; a person's explicit Regenerate remains an explicit request. The second controls the idle-archive exemption for an already pinned thread, and does not create or remove pins. Per-thread `titleSource` and `conversationPinnedAt` remain authoritative thread state, not workspace settings.

`archiveIdleAfterDays` retains 0/3/7/14/30/90. Open or draft published pull requests prevent idle auto-archive, regardless of the idle threshold. Explicit manual archive remains available. `subagentMaxConcurrent` is workspace-only, defaults to 6 and accepts 1–20. Every read exposes `value` and `source` through P1.

The browser subagent cap keeps the existing per-owner/per-workspace accounting. Increasing the workspace limit wakes existing queued workflows after commit. No new polling loop is added.

`PATCH /api/devices/:deviceId/settings?workspaceId=:workspaceId` accepts `{ maxConcurrentRuns: number }` (integer 1–64) and returns `{ deviceId, maxConcurrentRuns }`. `settings.patchDeviceConcurrency` is the desktop RPC action. The owner may write their device; an administrator may write only a device with an actual checkout or cloud-thread binding to the admitted workspace whose owner remains a member. A membership in an unrelated workspace grants no rights. The scheduler already consumes `devices.maxConcurrentRuns`.

Validation: root and API type checks, targeted lint, 10 registry/title units and 8 PG17 tests passed with no skips. The database tests exercise authenticated routes, actual persisted inheritance/archive queries, open/draft PR protection, device authorization and capacity, a saturated subagent queue and concurrent manual title edits. Title generation uses an injected fake function. No real model or production database is used.

Rollback is an ordinary application revert; this P adds no migration. Personal/workspace values remain in P1's additive typed tables, and existing pin/title state remains intact. Lowering a limit does not kill existing work; it stops new admission until capacity is available.
