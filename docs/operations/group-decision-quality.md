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

Only settled charges matching the provider generation and model in the current
primary routing receipt are reported as `decisionCostUsd`. Missing charges remain
`null`. The API and comparison report name this `primary-routing-decision-api`.
It excludes correction and incremental-contribution Decisions, earlier retries,
chat generation, Factory execution and external subscriptions. It is therefore
not a total cost for the group turn or its delegated task.

A confirmed Factory receipt records a delegation even when `on_completion`
suppresses the acknowledgement. Task-result and publication events commit with
the actual result message. `taskFinishedAt` records confirmed completion or
cancellation separately from the intake turn's `finishedAt`; task end-to-end
latency remains unknown until that result arrives. Status queries and stop
commands are not counted as new delegations.

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
from the fixed dataset and `policyVersion` (`group-route-v0` or
`group-contribution-v1`). It requires the caller's normal authenticated group
and workspace membership and token workspace scope. The call uses the same
Decision API, provider receipt validation, model admission and paid usage
ledger as ordinary routing. There is no arbitrary prompt, member, billing
identity, task or tool input. Selecting a replay policy does not change the
live policy.

The input consists exclusively of the reviewed synthetic fixture's message,
public member descriptors, recent context and synthetic task references.
Expected labels never reach the model. The response contains input/dataset
digests, policy, safe provider receipt, validated route, primary Decision
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

The runner checks the fixed production deployment before every call, runs
both policy versions sequentially, and stops on an unavailable response
without retrying or selecting another provider. It stores every received
receipt, including failures, and emits a Decision-only comparison: measured
coverage, action/responder accuracy, selected false/missed interventions,
known/unknown cost and latency. Full execution, noise, task completion and
production acceptance still require the real group-turn evidence above.
No replay result changes the production policy automatically.

### Policy release

The default policy is `group-contribution-v1`. It judges intervention value
and the member's duty separately and prefers one capable responder.
`group-route-v0` is the explicit rollback baseline, retaining the older
forced-responder behavior. Only reviewed code or authorized deployment
configuration selects a policy; feedback never rewrites its prompt.

The comparison emits a review gate, not an automatic release. Missing
coverage, worse recall, more false wakes, more noise, worse responder
accuracy or a failed candidate expectation block the gate. The report always
sets `productionAccepted: false` and `policyChanged: false`: production
acceptance also needs actual API/CLI execution at an immutable deployment.

For an incident rollback, set `MIKKA_GROUP_DECISION_POLICY=group-route-v0`
through the existing configuration delivery path and deploy the reviewed
revision. Retain the current trace schema and feedback. Verify the selected
policy in the next trace; an unknown configuration value fails explicitly.
To restore normal behavior, remove the override or select
`group-contribution-v1`, deploy and repeat the relevant fixed cases.

Do not turn a small number of likes into a policy update. Review false-wake
and missed-intervention examples together, separately identify infrastructure
faults, and retain the prior policy and exact comparison evidence with the
change.
