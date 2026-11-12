# Mikka test audits

Use `test-audit` when writing or reviewing tests, consolidating duplicate proof,
or investigating CI cost. Start with the affected owner and its callers. Use
[campaign mode](CAMPAIGN.md) when the task calls for a whole-subsystem audit.

[Test ownership and CI cost](../../../docs/ci/test-ownership.md) owns Mikka's
audit and measurement workflow. Use its evidence requirements and the existing
[dependency-aware selection](../../../docs/ci/incremental.md) to choose checks.
Keep each independent contract and name its surviving proof before removing a
test. Static checks and slow tests can protect package, config, migration,
security or release contracts; their execution cost alone is not a deletion
reason.

The upstream OpenClaw boundary guide and proof policy are linked at the pinned
revision as background. Their Vitest, `check-changed.mjs`, `deadcode:*` and
autoreview instructions describe OpenClaw's tooling. For Mikka, follow
[`AGENTS.md`](../../../AGENTS.md),
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md) and the
[workflow reference](../../../.github/workflows/README.md). Run the retained
owner and sibling checks appropriate to the change, with their real setup.
Record unavailable proof and remaining risks. A focused audit does not require
unrelated repository-wide tests or a new test framework.

The [skill registry](../README.md) records the upstream commit, license and
local adaptations. The three upstream Markdown files are retained in full;
the entry-point note and fixed cross-repository links are the only changes.
