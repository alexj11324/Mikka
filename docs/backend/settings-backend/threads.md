# Thread settings

P2 of #2956 uses the P1 registry and typed value tables. No new field-specific migration is needed.

The inherited `protectManualThreadTitles` and `keepPinnedThreadsActive` defaults are both true, preserving the existing behavior. The first controls automatic renaming; a person's explicit Regenerate remains an explicit request. The second controls the idle-archive exemption for an already pinned thread, and does not create or remove pins. Per-thread `titleSource` and `conversationPinnedAt` remain authoritative thread state, not workspace settings.

`archiveIdleAfterDays` retains 0/3/7/14/30/90. Open or draft published pull requests prevent idle auto-archive, regardless of the idle threshold. Explicit manual archive remains available. `subagentMaxConcurrent` is workspace-only, defaults to 6 and accepts 1–20. Every read exposes `value` and `source` through P1.

Implementation and validation are in progress. No real model or production database is used.
