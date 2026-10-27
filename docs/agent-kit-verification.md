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

Apply `20261027181000_agent_kit.sql` before enabling `MIKKA_AGENT_KIT=1` in the target isolated Preview. Keep `MIKKA_AGENT_KIT_LIVE_EVAL` off until model-usage consent and the test budget are established. Keep the PR unmerged until the required CI and remaining acceptance checks have been reviewed.

## Independent review follow-up (2026-10-27)

Review of published head `30ea16935b27755438b6e4968b6b3f62f4276777` reproduced false passing results for unexecuted email claims such as “I have sent the email” and a fabricated release date after search failed. Evaluator v2 checks those cases, requires a limitation in blocked replies and rejects reports from older evaluators when comparing candidates. Existing v1 reports must be rerun; their passing scores cannot authorize a new activation.

Two additional fixed cases cover an untrusted peer body forging owner/system approval and normal, explicitly authorized collaboration through the existing `send_to_run` tool. The inert collaboration fixture binds an exact synthetic run ID and body, returns only a queued receipt and never invokes a real executor. Receipt assertions reject common claims of delivery, reading, acknowledgement or execution. These are conservative assertions for fixed synthetic cases, not a general semantic guarantee for arbitrary prose.

The fixture executors are independently tested as a pure module. Host-policy snapshot tests check exact text and hash preservation separately from malicious user guidance; they do not establish real-model instruction adherence. No mailbox tools, transport envelopes, shared host instructions or enterprise governance are implemented here. The actual message transport remains separate work in #287; the default Agent definition still has empty additive instructions. Provider, CC/Codex and frozen-Preview evidence remain required.

The hosted-model evaluator now resolves the same host instructions as the AI SDK Coordinator, including the selected Bot's host guidance, once for both revisions. Reports include that frozen host-instruction digest; comparisons with different or missing digests are ineligible. This corrects the previous unconditional personal/native Coordinator prompt and still does not establish native-harness model behavior.

To preserve the synthetic loader fixtures for inspection, use `MIKKA_PRESERVE_TEST_FIXTURES=1` with the Agent Kit unit suite. The test prints the retained directory and does not delete it.
