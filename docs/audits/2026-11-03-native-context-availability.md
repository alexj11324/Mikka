# Native subscription context availability

This is an incomplete live acceptance record, not a completed repair claim.

The new official-template runtime was released from
`e6d449e78a6751f2310f671d87e0e876c064bd0b`, worker digest
`fd19a90fd9e1b6b6b98a4a348b8e5ea0eb653dcd`. The first paid round used
application `dfb85ebeb973ccc056c43627a186e755c18b581c`, deployment
`dpl_2H1wBStFXqHo3CnjUPuVd1yn2evB`, at the normal production origin.
No API-key, alternate account or alternate model fallback was allowed.

## Observed failure

Claude's normal Bot dispatch created task
`5e614f79-694c-4846-8180-1bcc681caa79`, run
`d0169cfc-3f42-4d8b-8f8a-a66c3d709ae1`, on its dedicated official-template
instance. Its actual native session was
`0c5d5892-0024-4a88-b8c7-ac838378311c`; the Factory attempt had not yet
persisted that session ID when the first observation was taken. There was no
Bot cancellation tool call.

At 16:28:29.418 UTC the server logged `subscription_native_refused`,
`operation=null`, `phase=authorize`, `code=subscription_unavailable`,
`errorClass=unknown`. The HTTP wrapper returned 409 for this unexpected
authorization lookup exception. The worker recorded
`subscription_runtime_failed`, `phase=context_check`, `httpStatus=409`, and
cancelled the session. Earlier successful identity flags in that diagnostic
do not describe the failed lookup. The later provider-operation failure was
recorded after cancellation; it does not establish a provider credential
rejection as the original cause.

The same period also included a tool-authority 503 followed by successful
authority checks. The underlying infrastructure exception is not yet
identified; it must not be described as an actual credential revocation or
as a proven database failure. The reproduced defect is that an unexpected
availability failure was classified as an authoritative conflict, and a
temporary context transport failure had no bounded recovery.

A later owner-scoped read-only authority query found `stopRequestedAt=null`,
the child device still enabled, token expiry on the following day, and token
revocation at 16:28:51.384828 UTC, after the 16:28:29 refusal and cancellation.
That is consistent with cleanup following the cancelled run. The old
`errorClass=unknown` log also hid typed device-fence errors; it does not identify
the exact exception. The repair lets those existing types reach the common
device route, which preserves authoritative 401 versus unavailable 503.

Occurrence 6/10, impact 8/10: one failed recurring lookup cancelled an actual
subscription run after native startup. Authorization must still fail closed
on explicit refusal, mismatched identity, revoked access or expired context.

## Independent progress

Codex's normal Bot dispatch created task
`e86f46a0-6fcf-4054-896e-b769a7b39f13`, execute run
`eb030fa1-3d81-4acf-878a-20bb940aa7f2`, native session
`01a1a23d-3a89-7110-8dc3-de45da0d761d`. Factory recorded execute passed and
started independent review run `15129143-74c8-4aaf-85c7-92275f7667b8`.
This proves neither final verification nor owner acceptance; those and
continuation and autonomous repository switching remain unaccepted.

The independent verify then correctly rejected that candidate. The expected
three-line file has 56 bytes; reading the fixed Git snapshot showed 58 bytes,
with an extra blank line after the marker and another after the arithmetic.
Review had relied on the producer's statement of exact-content success and
could not independently observe the text. The existing artifact reader only
returned byte/hash/Git metadata. The repair extends that same read-only tool
with complete UTF-8 text up to 64 KiB and optional exact expected-byte
comparison; binary/oversized text remains explicitly unavailable. No shell,
write capability or new tool is granted. Report-only instructions require
independent observations rather than a producer's self-report.

The later automatic retry was stopped through the normal owner thread stop
API, preserving the failed candidate and check history. Neither provider's
first round is a completed acceptance.

## Repair and verification boundary

Unexpected runtime/authority exceptions return retryable HTTP 503, with the
same bounded error body and no credential disclosure. Explicit subscription
and worker refusals retain HTTP 409. A later request must perform current
authorization again; an unavailable lookup must grant nothing.

The native-context client must retry only temporary transport/server
unavailability within a small, abortable bound. A successful current context
and the existing live checks are required before using its result. This does
not retry a provider generation, change credentials, reuse a stale successful
authorization, extend a lease or relax revocation. The periodic timer already
has a reentry guard; no missing-guard claim is made.

The HTTP regression reproduced 409 instead of 503 before the fix and passed
afterward, including reauthorization after recovery, typed fence propagation
and unchanged explicit refusal behavior. Daemon regressions exercise actual
test CLI lifecycles: recovery before forwarding, exhaustion, authoritative
refusal, abort during backoff and expired context. Reader regressions reproduce
the actual extra-blank-line mismatch without trimming or normalizing it.
Immutable CI and a new real official-subscription round remain required before
declaring completion.

## Complexity and publication coordination

The independent [complexity review](2026-11-03-native-runtime-complexity.md)
found redundant current-state queries and admitted-audit writes from probes.
The narrow simplifications share only an in-flight liveness query per gate,
without caching a successful result, and suppress successful-admission audit
writes for context probes while preserving all model checks and denied-use
audits. Larger stream/build/release simplifications and the Go availability
classification gap remain separate, unimplemented findings.

Cancelling parallel production builds to keep a mutable-domain test fixed
interfered with another repair session's release. That coordination method was
stopped at the user's instruction. The Neon repair session now owns production
publication; this session no longer cancels deployments, rolls back service,
changes production environment or independently triggers release. The latest
main changes must be retained. New acceptance must record an agreed immutable
version rather than block other releases.
