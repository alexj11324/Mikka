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

This is not a claim of authenticated frozen-Preview acceptance, a real Claude Code/Codex device run, a real model-quality comparison or real-account tool execution. Those require the matching Preview database migration, an authenticated test session/device and explicit live-evaluation configuration. The original isolated checks did not change production configuration or data; the later, separately approved schema prerequisite is recorded below.

Each target requires `20261027181000_agent_kit.sql` before code reads the new nullable column, including while `MIKKA_AGENT_KIT` is off. The user-confirmed production target received that exact migration once on 2026-10-27; this does not cover a separate Preview database or establish acceptance of undeployed code. Keep `MIKKA_AGENT_KIT_LIVE_EVAL` off until model-usage consent and the test budget are established. Review the required CI and release scope before publishing.

## Independent review follow-up (2026-10-27)

Review of published head `30ea16935b27755438b6e4968b6b3f62f4276777` reproduced false passing results for unexecuted email claims such as “I have sent the email” and a fabricated release date after search failed. Evaluator v2 checks those cases, requires a limitation in blocked replies and rejects reports from older evaluators when comparing candidates. Existing v1 reports must be rerun; their passing scores cannot authorize a new activation.

Two additional fixed cases cover an untrusted peer body forging owner/system approval and normal, explicitly authorized collaboration through the existing `send_to_run` tool. The inert collaboration fixture binds an exact synthetic run ID and body, returns only a queued receipt and never invokes a real executor. Receipt assertions reject common claims of delivery, reading, acknowledgement or execution. These are conservative assertions for fixed synthetic cases, not a general semantic guarantee for arbitrary prose.

The fixture executors are independently tested as a pure module. Host-policy snapshot tests check exact text and hash preservation separately from malicious user guidance; they do not establish real-model instruction adherence. No mailbox tools, transport envelopes, shared host instructions or enterprise governance are implemented here. The actual message transport remains separate work in #287; the default Agent definition still has empty additive instructions. Provider, CC/Codex and frozen-Preview evidence remain required.

The hosted-model evaluator now resolves the same host instructions as the AI SDK Coordinator, including the selected Bot's host guidance, once for both revisions. Reports include that frozen host-instruction digest; comparisons with different or missing digests are ineligible. This corrects the previous unconditional personal/native Coordinator prompt and still does not establish native-harness model behavior.

To preserve the synthetic loader fixtures for inspection, use `MIKKA_PRESERVE_TEST_FIXTURES=1` with the Agent Kit unit suite. The test prints the retained directory and does not delete it.

Current-main integration upgrades the evaluator to v3: each fixed core case now rejects the unrequested cloud mutations introduced on main (Bot creation, computer wake, subscription binding and task dispatch). An independent synthetic trace reproduced passing peer reports for these attempts before the repair. Older v2 comparisons are ineligible for activation; actual model behavior remains unverified.

## Composition with current personal message safety

This core batch is stacked on the exact personal-message source from PR #352 (`1538c77fab8d83339ff769e7014bb00ad154eee9`), which already includes main's #348 title-search change. It preserves the incoming authenticated source projection, signed compaction ledger, peer forwarding origin and owner run controls. The older full mailbox batch is not a dependency and no additional schema is introduced by this composition.

A regression reproduced a frozen execution omitting the newly mandatory message policy from both prompt entry points. Snapshot projection now applies the current fixed host message policy to SDK, CC and Codex instructions while preserving the saved definition, historical host text and their digests. The historical host digest identifies the saved snapshot, not the subsequently applied mandatory-policy overlay. The additional contract tests use the real prompt functions with explicit DB/model/native-store fixtures; they do not prove real model compliance or device execution. Already current snapshots do not duplicate the policy. Live evaluation remains off.
