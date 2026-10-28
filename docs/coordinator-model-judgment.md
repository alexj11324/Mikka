# Coordinator judgment boundaries

This change is based on main `dd6d8d4febbfe56bba5671cc5302c20f8e0e533d`.
It changes source and offline contracts. It does not establish runtime acceptance,
turn on a feature, run live evaluations, or permit a merge/deployment.

## Continuous task goal

The user assigned this thread independent delivery of the shared Coordinator
model-judgment executor, authenticated image entry, unknown/bounded retry behavior
and host-bound execution receipts, compatible with the group, Factory and action
consumers. No thread set-goal tool is available; this is the continuing task goal,
not a platform goal-setting receipt.

Implementation, source review, retention audit, applicable real functional
acceptance on the final exact SHA and required platform gates must all complete
before a normal fixed-SHA merge. Historical green checks, mocks, default-off flags,
live-eval or benchmark scores cannot replace that acceptance. Existing access,
single-writer boundaries, the resource-retention hold, live-eval OFF and native
Coordinator unset remain in force. No formal GitHub APPROVE is authorized by this
goal. Shared retain scripts belong to #364 and issue-scope logic to #301.

| Responsibility | Consumer and behavior |
| --- | --- |
| Business judgment | `triage.ts` asks for an explicit model choice for runtime events; `wake.ts` retains an unavailable judgment as a nullable, undelivered tier. No failed/blocked status automatically means a person is needed. |
| Group selection | `route-group.ts` calls the model even with one member. The model chooses selected/everyone/clarify. Missing answers stay pending. Confidence is optional metadata, never a confirmation threshold. Model-selected routes carry the host invocation receipt; mentions do not invent one. Exact authorized mentions remain direct delivery. |
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
Existing lease, scope and delivery guards remain in effect. Successful model observations log only event IDs and host invocation metadata, not report text, credentials or pixels; this does not claim that a concurrent tier compare-and-set succeeded.

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
The evaluation/compaction corrections themselves require no new SQL. The durable
triage attempt/receipt correction below has its own schema prerequisite.

The source now claims a scoped attempt before inference and orders future batches
by the last attempt or original creation time. A fifteen-second cooldown is longer
than the ten-second classification budget. Each chat/wake performs at most eight
model requests, with at most two attempts per event. Direct user delivery does not
consume that model budget. Unknown or cancelled classification stays pending;
untouched rows do not receive a fabricated attempt time.

Completion atomically records the tier and host model receipt only when owner,
Bot, event ID/kind/payload/run/issue, observed creation time and attempt token still
match and the event remains unclassified/undelivered. A logged provider response
is not proof that the compare-and-set won. The original creation timestamp is not
repurposed as a retry cursor; PG microseconds are compared at the driver's observed
millisecond precision.

The new schema-only prerequisite is
`drizzle/20261028223600_coordinator_triage_attempt.sql`: nullable
`coordinator_events.lastTriageAttemptAt` and `triageDecision`, no cleanup or data
backfill. This source has not executed that SQL. Schema must precede the code,
including when optional features are off, because full-row Drizzle reads include
the added columns. Resource-retention, target authorization and real database
acceptance remain prerequisites; historical Agent Kit DDL permission is not reused.

`triage-batch.test.mjs` is a separate native-Node offline scheduling
check: only Node built-ins and the production type-stripped scheduler, without
tsx/esbuild, filesystem fixtures, DB, network or teardown. Its exact native Node
execution closure received independent static review; on `c4dac112` its nine
cases passed at 2026-10-28 22:51 UTC, with no skips or TODOs. It does not establish
SQL fairness, provider behavior or real visual acceptance. Existing framework
integration and PG cases remain HOLD; their assertions have not been removed to
obtain a green result.

## Authenticated user images

The existing authenticated `POST /api/coordinator/messages` accepts optional
`images: [{ dataUrl }]`, inline PNG/JPEG/WebP only, at most two images of 1 MiB
each and a 3 MiB total JSON body. The stream is bounded even if Content-Length
is missing or false. No external URL is fetched. The normal text Server Action
keeps its existing interface and body limit; clients submitting images use POST.
This change does not add or alter a frontend attachment control.

The host derives the media type, byte count and SHA256, persists them in the
authenticated owner's user event and revalidates them when taking the inbox.
Peer/tool payload images cannot stamp a user event. Real image file parts reach
`preparePrompt` and the AI SDK. The response and request logger do not echo image
bytes; private source rows are not automatically deleted. This does not claim
that image metadata has been redacted or that model image content grants rights.

Signed compaction keeps the newest user decision and up to two recent user image
records separately, with each image bound to its original event/time. Later text
cannot relabel or erase the retained image source. Omitted image references/counts
are explicit: an old image outside that pixel budget is not visually available
to the model, and summary prose cannot substitute for it. Wrong-scope or unsigned
summaries cannot supply pixels. Actual tool JSON is counted as text regardless
of nested fields named `type`, `image` or `mediaType`.

The image entry regression begins with a synthetic HTTP body, authenticates via
an explicit test session, persists through the real submission code into a
SQL-shaped transport fixture, takes the real inbox, prepares the real prompt,
and checks decoded pixels at the actual installed AI SDK model interface before
and after repeated compaction. Its database transport and model are substitutes,
not evidence of a deployed request, real PostgreSQL or a real provider response.

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
do not establish deployed group behavior. The Factory owner reports a newer
`276a640` implementation with read-before-model and short transactions. That
source has not been materialized in this checkout, so the old lock/replay finding
is not asserted against the newer version. This change does not edit or claim
independent acceptance of those files.

The user has selected `deepseek/deepseek-v4.1-flash` as the project default,
using the team's existing DeepSeek BYOK configuration through Vercel AI Gateway.
`lib/coordinator/model.ts` now selects that exact generative model. The public
Gateway catalog declares text/image/pdf input; catalog capability is not real
functional acceptance. Existing frozen runtime/binding selections stay unchanged,
including compaction, and no paid fallback is added to subscription execution.
No new model-selection decision is required from the user. The dedicated Decisions
API still uses its existing `openai/gpt-6-luna-decisions` contract; this is separate
from the generative default. Saving a provider BYOK key is not proof of the
application's Gateway credential injection or a successful image request. The
Gateway's documented default BYOK behavior can fall back to system credentials;
provider routing and actual credential-use evidence must not be inferred from
the model ID alone.

`scripts/coordinator-vision-functional.mjs` prepares two tiny synthetic images
entirely in memory and invokes the unchanged shared Decisions transport only
with an explicit execution argument and an existing authorized key injection.
No secret lookup, fixture directory, subprocess, database, tsx/esbuild, live-eval,
external action or resource teardown is part of that script. Its scoped native
Node resolution uses Next's existing backend marker and the actual source files.
The script requires its own independent execution-closure review before running;
the default dry-run makes no inference request. Two real component calls cannot
establish deployed HTTP/auth/image persistence or database scheduling acceptance.

## Resource retention hold (2026-10-28)

The user's latest instruction stops automatic resource/data/directory cleanup
and requires retained resources and audit logs. No affected test or build may be
restarted merely because its repository teardown was edited. Source/type work
that does not invoke those paths continues. Production and Staging are not part
of this audit.

Current source retains migration-test fixture directories, worker build scratch,
and Coordinator database fixtures. Agent Kit database setup now checks existing
schema metadata instead of automatically creating/replaying the migration that
replaces triggers. Migration replay is explicitly TODO; the required database
runner rejects TODO, so this is not a passed migration gate.

The `a6bede2` isolated build started at 21:49:55 UTC and its task-exclusive process
group 8684 was paused with SIGSTOP at 21:51:23 UTC, without TERM/KILL, cleanup or
resume by this thread. At 22:47:05 UTC a readback found parent 8684 absent and
the remaining group members zombie/PPID 1. The transition time and cause are
unknown; do not claim they remain paused or restore/recreate them. The original
build directory/log still exist, without a result file. Its log proves four
migration-mode fixture cleanup callbacks had already
completed. Random directory suffixes and deleted file counts were not logged;
they are unknown. Do not reconstruct or restore them. Older passing runs remain
historical execution evidence, not acceptance under the new retention rule.

Installed Next, tsx and esbuild contain their own cleanup paths. The full build
and affected test entrypoints remain HOLD; repository teardown changes do not
prove those dependency paths are retained. The separately reviewed native
scheduler check does not lift those holds or authorize SQL, provider calls, CI,
merge or deployment. Retained evidence records each separately reviewed command.
