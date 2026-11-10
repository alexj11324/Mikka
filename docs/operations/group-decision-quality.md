# Group decision quality

The production group turn records the Decision API receipt and the actual work
that follows it. A successful silent turn is `complete` with `ignore` or
`observe`; an unavailable or invalid judgment is `blocked` and retains the
existing `group_judgment_pending` diagnostic. They must not be combined in an
engagement metric.

## Trace and feedback

`GET /mikka/api/conversations/:id/decisions?limit=50` returns at most 100 turns
to a current group and workspace member. The route also enforces the existing
token workspace scope and origin checks. It returns message references, a
version of the member/capability snapshot, the policy version, structured
decision, host receipt, event counts and terminal state. It does not export
message bodies, role instructions, credentials or private peer conversations.

Events distinguish wake attempts, model generations, silent generations,
public/private publications, durable delegation and server-confirmed task
results. Publication events are written in the publication transaction.
Host-assigned event IDs make receipt retries idempotent. A content digest
supports exact duplicate-publication measurement without copying the reply.

`POST` to the same route accepts only:

```json
{
  "messageId": "the-original-user-message-uuid",
  "kind": "wrong_member",
  "targetId": "an-active-group-member-uuid"
}
```

Allowed explicit kinds are `helpful`, `unhelpful`, `wrong_member`,
`missed_intervention`, `unwanted_task`, `reaction_positive` and
`reaction_negative`. `targetId` is optional. The authenticated caller and
feedback provenance are server assigned; clients cannot choose a different
user, source or policy version. Repeating the same feedback updates its target
instead of multiplying the sample.

Existing mobile reactions to a reply are joined to its original turn as
`human_reaction`. Removing or changing a reaction is reflected on the next
read. They remain distinct from explicit feedback, model-interpreted human
corrections, human cancellation and automated evaluation. None is a trusted
label by itself: the response always says `feedbackIsGroundTruth: false`.

The API prices the retained routing Decision chain against settled ledger
receipts. `costScope` is `routing-decision-chain`. Each retained decision keeps
its phase, index, frozen policy version, status, failure and provider receipt.
`decisionCalls` reports attempted, receipted and unreceipted calls.
`decisionCost` separates known USD/calls, unknown calls and omitted calls.
`decisionCostUsd` stays `null` if any attempted or omitted cost is unknown.
Receipt IDs deduplicate repeated generations. Complete chain latency also stays
unknown when receipts are missing or omitted. Correction and incremental
contribution Decisions, chat generation, Factory work and subscriptions remain
outside this routing-chain total. The older observation-file scorer
`scripts/group-decision-eval.mts` still labels its imported aggregate
`primary-routing-decision-api`. Preserve that evidence format's scope when
comparing it with the richer live/replay chain.

A confirmed Factory receipt records a delegation even when `on_completion`
suppresses the acknowledgement. Task-result and publication events commit with
the actual result message. `taskFinishedAt` records confirmed completion or
cancellation separately from the intake turn's `finishedAt`; task end-to-end
latency remains unknown until that result arrives. Status queries and stop
commands are not counted as new delegations.

Completion follows the existing Factory outcome: accepted reports/deliverables
finish at `approval/passed`, merged repository candidates at `publish/passed`,
and monitored publications at `monitor/passed`. The first two require the
matching host acceptance/merge ledger, current candidate and current request
epoch. A stage name or model claim alone cannot mark the task complete. Final
reports keep the producing thread and current-epoch artifact references;
merged code is not described as a successful deployment.

## Fixed regression set

`tests/fixtures/group-decision-cases.json` contains synthetic, manually
annotated cases, including ordinary conversation, an answered question,
unrelated content, UI/testing duties, an ambiguous task, a new member,
explicit mention, provider failure, duplicate delivery, prompt injection,
multiple requested perspectives, delegation and useful silent delegation.
Its labels need human review before they become a release criterion for a
new policy. Test-generated observations only validate the scorer; they do
not establish live model quality.

Record one actual observation per case, preserving its case ID. Each evidence
file has `policyVersion`, `datasetDigest` (SHA-256 of the exact JSON fixture),
`revision` (40-character Git SHA), `modelId`, `evidenceKind` and
`observations`. Use `groupTraceObservation` for runtime traces. Preserve
unknown latency/cost as `null`, and record expected failures and duplicate
deliveries rather than silently dropping them. Keep live, historical and
synthetic evidence separate.

Compare observations with:

```sh
node --import tsx scripts/group-decision-eval.mts \
  --baseline baseline-observations.json \
  --candidate candidate-observations.json \
  --output group-decision-comparison.json
```

The comparison requires the same fixed dataset and Decision model, and
rejects missing/duplicate cases and invalid counters. It reports useful
intervention precision/recall, false wakes, missed intervention, responder
accuracy, public replies per user message, excess/duplicate publications,
delegation completion, known/unknown decision costs, decision latency and
turn latency. A silent delegation counts as useful work; no public reply
alone is not a missed intervention. An invalid or unavailable decision is a
fault observation, not intentional silence.

## Review, release and rollback

### Real fixed-case Decision inference

`POST /mikka/api/conversations/:id/decisions/replay` accepts only `caseId`
from the fixed dataset and `policyVersion` (`group-route-v0`,
`group-contribution-v2`, `group-contribution-v3` or `group-contribution-v4`).
Historical v1 receipts remain readable, while the HTTP replay schema rejects
v1. The route requires the caller's normal authenticated group and workspace
membership and token workspace scope. The call uses the same
Decision API, provider receipt validation, model admission and paid usage
ledger as ordinary routing. There is no arbitrary prompt, member, billing
identity, task or tool input. Selecting a replay policy does not change the
live policy.

The input consists exclusively of the reviewed synthetic fixture's message,
public member descriptors, recent context and synthetic task references.
Expected labels never reach the model. The response contains input/dataset
digests, policy, safe provider receipt, validated route, routing-chain Decision
cost and latency. It does not contain customer content or credentials.
The replay digest hashes `JSON.stringify` of the parsed fixture, unlike the
raw-file digest used by the runtime-observation import format above.

This is **actual Decision inference; execution projected/not performed**.
It never wakes a Bot, generates a chat answer, executes a tool, creates a
Task or posts a group message. Selected intervention and reporter counts are
projections, not measured generation/publication counters. The separate
`decision-outage` and `duplicate-delivery` cases remain runtime tests; a
model is not asked to pretend a transport outage or idempotent replay.
Missing receipts and invalid decisions reduce coverage rather than becoming
successful silence.

Use an existing authenticated session or PAT of the authorized test user,
the fixture conversation, and the immutable deployment and Git revision:

```sh
# Supply GROUP_REPLAY_COOKIE or GROUP_REPLAY_TOKEN through the existing
# credential delivery mechanism. Do not put either in source or reports.
export GROUP_REPLAY_CONVERSATION='<fixture-conversation-uuid>'
export GROUP_REPLAY_DEPLOYMENT='<dpl_id>'
export GROUP_REPLAY_REVISION='<40-character-git-sha>'
node --import tsx scripts/group-decision-replay.ts --output decision-replay.json
```

The runner checks the public source revision before every call and runs the
baseline `group-route-v0` and candidate `group-contribution-v4` sequentially.
The owner separately verifies the supplied deployment ID and current alias.
The public version check alone does not bind two deployments of the same SHA.
It stops on an unavailable response
without retrying or selecting another provider. It stores every received
receipt, including failures, and emits a Decision-only comparison: measured
coverage, action/responder accuracy, selected false/missed interventions,
known/unknown cost and latency. Full execution, noise, task completion and
production acceptance still require the real group-turn evidence above.
No replay result changes the production policy automatically.

### Policy release

The live policy constant is `group-contribution-v4`. It judges intervention value
and the member's duty separately and prefers one capable responder.
`group-route-v0` is the explicit rollback baseline, retaining the older
forced-responder behavior. Only reviewed code or authorized deployment
configuration selects a policy; feedback never rewrites its prompt.

The comparison emits a review gate, not an automatic release. Missing
coverage, worse recall, more false wakes, more noise, worse responder
accuracy or a failed candidate expectation block the gate. The report always
sets `productionAccepted: false` and `policyChanged: false`: production
acceptance also needs actual API/CLI execution at an immutable deployment.

The `groupContribution` deployment switch selects the live constant when on
and `group-route-v0` when off. For an incident rollback, use the existing
`mikka-group-contribution-off` kill switch through the authorized PostHog CLI
path. Retain the trace schema and feedback, then verify `group-route-v0` in the
next trace. The legacy `MIKKA_GROUP_DECISION_POLICY=group-route-v0` setting
also requests the baseline when no remote flag answer takes precedence.
Historical v1/v2/v3 environment values enable the switch and select the live
constant. They do not pin live execution to those older versions. To restore
the live policy, turn the kill switch off and repeat the relevant fixed cases.
Explicit replay versions remain independent of the live switch.

Do not turn a small number of likes into a policy update. Review false-wake
and missed-intervention examples together, separately identify infrastructure
faults, and retain the prior policy and exact comparison evidence with the
change.
