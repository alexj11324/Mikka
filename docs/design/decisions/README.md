# Effective decisions and historical provenance

**Current behavior comes from the latest explicit user decision, current `AGENTS.md`, `docs/design/rules.md`, accepted design, and verified implementation.** This directory records *why* a decision was made; its date does not make it active forever.

## When instructions disagree

1. Follow the latest explicit approved decision and update the current product or release rule in the same PR.
2. Do not use a superseded ADR, `../decisions.md`, dated audit, screenshot gallery or issue comment as the sole present-tense authority.
3. When a historical record names a successor, read the successor. If history conflicts with current code and the decision is unknown, record the mismatch without silently reverting product behavior.

## Maintaining the current version

For new significant decisions, record the durable current rule in `AGENTS.md`, `rules.md`, or the appropriate product/operations reference first. Keep a small dated ADR only when provenance is useful for safety or compatibility.

When a superseded note has no remaining active links, tests or release dependencies, remove the tracked snapshot in a reviewed docs-cleanup PR. Git retains prior commit content unless a separately approved history rewrite occurs. **Never delete** live migration ledgers, security evidence, rollback references or paid-library implementation as a way to reduce documentation volume.

The older `../decisions.md` is legacy background, not an instruction to recreate old interfaces or release paths. The [One UI decision](2026-11-08-2133-one-ui.md) still defines a single user-facing UI. Current build ownership is at [build source of truth](../../operations/build-source-of-truth.md).
