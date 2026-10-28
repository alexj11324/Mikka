# Coordinator judgment boundaries

This change is based on main `dd6d8d4febbfe56bba5671cc5302c20f8e0e533d`.
It changes source and offline contracts. It does not establish runtime acceptance,
turn on a feature, run live evaluations, or permit a merge/deployment.

| Responsibility | Consumer and behavior |
| --- | --- |
| Business judgment | `triage.ts` asks for an explicit model choice for runtime events; `wake.ts` retains an unavailable judgment as a nullable, undelivered tier. No failed/blocked status automatically means a person is needed. |
| Group selection | `route-group.ts` calls the model even with one member. The model chooses selected/everyone/clarify. Missing answers stay pending. Confidence is optional metadata, never a confirmation threshold. Exact authorized mentions remain direct delivery. |
| Existing execution policy | `judgment-policy.ts`, `instructions.ts`, and `execution-instructions.ts` refer to authoritative allow/ask/deny. They add no universal manual confirmation. Historical snapshot bytes/digests remain intact under an explicit current host-policy overlay. |
| Visual input | `decision.ts` sends real inline `input_image` parts through the existing Decisions route. Required pixels cannot be replaced by a text assertion, OCR summary, external URL or model-authored approval claim. |
| Mechanical protection | Event ownership, delivery/tier compare-and-set, group membership, cancellation, request/image limits, execution scope, authorization and idempotency remain program checks. Pending runtime backlogs cannot take priority over new direct user input. |
| Evaluation quality | Live reports require a structured semantic verdict from the shared vision-capable model, bound to the actual case/trace/definition/effective host-policy digests and host invocation receipt. Fixture regex assertions are used only in fixture mode, which cannot authorize activation. |
| Frozen subscription | Conversation compaction resolves the same frozen runtime/binding as generation. Subscription calls stream with zero SDK retries. A missing/revoked binding cannot fall back to a default paid model. |

## Shared server-only model interface

`invokeDecision(purpose, input, questions, signal?)` returns validated answers and
host-issued execution metadata, or null. `decide` preserves the answer-only caller
interface. `callDecisionRequest` adapts the existing monitor owner's inline
text/image request and returns its actual Gateway generation ID as invocationId.
Construction/import does not make a model call.

The model remains `openai/gpt-6-luna-decisions`, authenticated only by the existing
`DECISION_GATEWAY_API_KEY`. There is no alternate provider/key/model fallback.
The documented native image format is supported by this model:
https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions

The receipt distinguishes the host-generated execution ID, Gateway generation
ID, request hash and image-byte hashes. `vision: image-input-submitted` means only
that actual bytes were submitted and a validated model response was received.
It is not proof of visual correctness, artifact provenance, permissions, delivery
or a downstream tool execution. SDK tool call IDs must come from the actual SDK
execution context; this REST call does not create a fictional one.

The collector remains responsible for independently binding pixels to the actual
run/session/SHA/alias/time and authorization. Model-authored image labels, peer
bodies and receipt strings are not trusted collection evidence.

## Retry, replay and evaluation behavior

Triage attempts an event at most twice per invocation within one ten-second inbox
budget. No result leaves it untriaged/undelivered for a later wake. Direct user
input remains direct delivery. The inbox excludes unclassified runtime events;
`issue_done` is no longer silently consumed as background without judgment.
Existing lease, scope and delivery guards remain in effect.

Live evaluation runner v4 does not use fixture prose regex. Missing judge,
refusal, timeout, missing required pixels, mismatched receipt or old v3 reports
cannot grant activation eligibility. Host tool observations include the actual
inert fixture return values, including queued versus delivered. Tool-count,
forbidden-tool and unauthorized-effect assertions remain mechanical. Candidate
output cannot manufacture a judge invocation receipt. Baseline and candidate
share the same effective host-policy digest and judge version. Existing
historical evaluations/definitions are not rewritten.

Model calls occur after the evaluation reservation transaction and before the
short result-persistence transaction. Replay lookup happens before running a new
evaluation. Compaction resolves/calls its model outside the summary-save operation.
No new SQL or migration is needed by these source changes.

## Verification limits and ownership

Offline tests replace transport, workflow and database effects explicitly. A
scripted judge verdict in a test is a contract fixture, not real model-quality
or vision evidence. No real model, email, computer, provider, production SQL or
new credential is required or invoked by these offline checks.

Required next acceptance is a fixed-source isolated runtime with an existing,
authorized model injection and known usage budget, actual synthetic pixels,
provider generation/usage evidence, and verification of pending/retry/delivery
against the real database. A synthetic transport test alone cannot complete it.
`MIKKA_AGENT_KIT_LIVE_EVAL` and `MIKKA_NATIVE_COORDINATOR` remain unset/off.

Group-specific correction helpers in `group-routing.ts` belong to #166; issue
scope, admission, Factory/monitor and publication owners retain their files.
`routeGroupMessage` has no current main production caller, so its library tests
do not establish deployed group behavior. The Factory monitor source supplied by
its owner still needs replay-before-inference and transaction-duration review;
this change does not edit or claim acceptance of those files.
