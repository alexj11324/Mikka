# Agent Kit implementation verification

## Implemented scope

Declarative, versioned Agent definitions and a confined Markdown/file loader; a shared executable tool registry for the AI SDK and native Coordinator relays; immutable, owner/Bot-scoped execution snapshots; registered audit and failure-case hooks; lazy Bot Skill loading; checksummed import/export; authenticated management APIs; and a controlled instruction-only improvement lifecycle.

After an execution finishes, the failure-case hook may automatically propose one candidate for its current baseline once three distinct failed executions supply evidence. Candidate generation is rule-based and never activates its own output. Live evaluation, explicit owner approval and an unchanged baseline are required for activation. Skill publication/Factory work in PR #316 is separate and is not merged by this change.

## Completed in an isolated cloud sandbox

- `pnpm check`: completed successfully, including definitions, pure tests, native relay/scope regressions, lint and typecheck. Existing optional database suites without their environment were skipped; they are not counted as database acceptance.
- `pnpm exec next build`: production build emitted the new definition route and completed prerendering in the 8 GB sandbox. The initial 4 GB attempt was killed and is not counted as a passing build.
- Agent Kit unit/HTTP suite: 26 passing tests.
- Agent Kit PostgreSQL suite: 11 passing tests, using real PostgreSQL 18 and the actual rerunnable migration in an isolated loopback database. Coverage includes concurrent initialization/edits, tenant isolation, pinned snapshots, immutable audit events, fixture rejection, approval replay, rollback and HTTP-to-database execution.
- Existing targeted native permission/prompt/model/retry tests: 32 passing tests.
- Existing native relay tests: 6 passing tests after preserving the unchanged argument shape when Agent Kit is disabled.
- CLI definition validation and fixture evaluator smoke test passed.

The database test that exercises approval uses explicitly synthetic report records. It verifies the gate's implementation, not real model improvement. Fixture evaluation never authorizes activation.

## Remaining release acceptance

This is not a claim of authenticated frozen-Preview acceptance, a real Claude Code/Codex device run, a real model-quality comparison or real-account tool execution. Those require the matching Preview database migration, an authenticated test session/device and explicit live-evaluation configuration. Production configuration and data were not changed.

Apply `20261027040500_agent_kit.sql` before enabling `MIKKA_AGENT_KIT=1` in the target isolated Preview. Keep `MIKKA_AGENT_KIT_LIVE_EVAL` off until model-usage consent and the test budget are established. Keep the PR unmerged until the required CI and remaining acceptance checks have been reviewed.
