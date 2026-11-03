# Factory continuation uses the current owner request

## Observed failure

On 2026-11-03 (UTC), both official subscription harnesses completed initial native execution, independent review and verification, followed by real owner UI acceptance. A subsequent normal thread continuation correctly changed the artifact, but its independent reviewer compared it with the original issue target: Claude Code expected 53 rather than 74 bytes; Codex expected 56 rather than 77 bytes. Codex automatic repair then restored the obsolete 56-byte artifact. These follow-ups failed acceptance; the two disposable repair loops were stopped through the normal owner API. Initial accepted history remains valid and unchanged.

Occurrence 9/10 × impact 8/10: an ordinary owner follow-up that changes exact content can be rejected and automatically reverted. This is a demonstrated execution-to-check contract defect, rather than a provider authentication failure.

## Minimal correction

Preserve the raw authenticated owner continuation in the existing coordinator event record, marked delivered/background because the thread action already dispatches it. Bind a new Factory request epoch to that source without editing the issue or earlier accepted task. Both independent checks and automatic repair receive this same current request; it supersedes changed older targets while retaining unchanged requirements and execution permissions. Automatic repairs and receipt replays retain their existing epoch. Validate owner, Bot, issue and parent-run identity before changing epochs. No schema, new queue, model parser, worker input, subscription or official E2B/CLI package changes are required.

## Verification and limits

The real isolated PostgreSQL thread-continuation/cloud suite passed 23 tests with no skips; the regression first failed against the prior behavior. Coverage includes the raw current request in checks and repair, unchanged accepted records and issue, replay/repair reuse, rejected identity mismatches, and absence of a second Bot inbox delivery. Application typecheck and prompt checks passed. Local regression coverage is not production acceptance: after a READY application release, both official subscriptions must complete a new continuation with actual file/Git evidence, independent checks and normal owner UI acceptance. The earlier failed continuations must remain recorded as failures.
