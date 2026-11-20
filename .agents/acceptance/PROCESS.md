# Run and review acceptance

Use this process to prove a Mikka change before merging it. The **runner**
operates the environment and captures evidence. A separate **checker** reviews
two plans and the final evidence without running the acceptance or changing
the implementation. The issue owner fixes findings and owns the merge.

## Scope and prerequisites

Read the owning issue, current `AGENTS.md`, and [project adapter](PROJECT.md).
Use an isolated cloud Linux application, loopback PostgreSQL 17 `*_e2e`
database, and the real daemon when the affected flow uses one. Tests and
acceptance use scripted models or sanitized recordings at the LiteLLM
boundary. No real model call or Neon branch is part of this procedure.

Use API/CLI acceptance for behavior. UI evidence comes from a local production
build of the official public/private pair. Public-only builds prove compilation,
not the official appearance. CI, packaged clients, serving production, and
external provider installation remain distinct evidence scopes.

Run typecheck, lint, unit tests, and isolated database tests for the changed
scope while implementing it. Acceptance adds the behavior and evidence check;
it does not remove applicable source, security, or database CI gates.

## 1. Review the scope plan

The runner sends the checker the immutable source revision, issue requirements,
affected entry points, and the proposed checks. Name a runner and a different
checker; a second self-review is not independent review. Keep the raw plan and
the checker's response with the issue or PR evidence.

Use this handoff format:

```text
Issue / PR:
Public source SHA / private UI SHA if applicable:
Runner / checker:
Affected user action or contract:
Required scope: API / CLI / UI / device / E2B / production-only exception
Existing evidence proposed for reuse:
Known gaps and external constraints:
```

Give every check an explicit contract:

| ID | Operation | Expected observation | Runtime | requiredEvidence |
| --- | --- | --- | --- | --- |
| A1 | Perform the changed API/CLI operation | Name the durable result and readback | device, E2B, or neither with reason | Exact command, exit status, request/run IDs, persisted readback |
| A2 | Exercise the relevant refusal or failure | Name the rejected operation and preserved state | Same affected runtime | Refusal response and independent unchanged-state observation |
| A3 | Capture the changed official screen | Name the scenario, state, and viewport | Official local production build | Public/private SHAs, scenario, screenshot link |

Replace these example rows with only the checks the change needs. List what
each fake controls and what real product owner still executes. Do not use a
fake's return value to prove a persistence path it bypasses.

The checker compares the plan with the issue and actual entry points, then
records `scope: accepted` or concrete missing coverage. Resolve the missing
coverage before preparing the execution plan.

## 2. Review the executable plan

The runner records exact commands, environment identity, test-account lease,
fixture names/provenance, expected artifacts, and cleanup. Identify the changed
checks to rerun and the unchanged evidence to reuse. Include an expected
negative control when it distinguishes a real regression from a vacuous pass.

The checker reviews this plan before execution. It verifies that the evidence
can distinguish the expected behavior, failures, and absent proof, that the
target database is isolated, and that the fakes cover outbound dependencies
without adding a direct model path. Record `execution plan: accepted` or the
specific corrections. This is a technical review, not another permission
request to Alex for already authorized work.

## 3. Execute and collect evidence

The runner holds source and environment fixed for each run, executes the
accepted plan, and records the result for every check. Keep the command,
exit status, UTC interval, tested source, fixture/scenario, and relevant
observed IDs with each artifact. Record actual item IDs and passed/total
counts; a started process or queued job is not a result.

Use the test-account pool's ownership and cleanup API. Capture only sanitized
summaries and intended screenshots. Keep credentials, cookies, raw secret
responses, and retained browser state out of Git, PR text, screenshots, and
logs. Link evidence by immutable commit or CI run instead of a moving branch.

Fix a product failure in the owning implementation and rerun the affected
checks. If the plan or source changes materially, return the changed rows to
the checker before executing them. Preserve the original failed observation.

## 4. Review the evidence

The runner sends the checker the accepted plans and raw evidence references,
without supplying a desired verdict. The checker reads those artifacts and
the changed source; it does not operate the environment, rerun the checks,
or repair the code. It assigns each row one result:

| Result | Meaning |
| --- | --- |
| `pass` | Every `requiredEvidence` item is present, tied to the tested source/environment, and supports the expected observation. |
| `fail` | Observed behavior contradicts the contract, or a selected command/check actually fails. |
| `uncertain` | Required evidence, source/environment binding, or the observation needed to decide is absent. |

Missing `requiredEvidence` always means `uncertain`, even if the runner says
the check passed. Queued, cancelled, skipped, and draft-only jobs never become
passes. A passing fake does not prove a real provider or a production deployment.
The final handoff lists every row's result, evidence, and remaining gap. Any
required `fail` or `uncertain` row keeps that scope unaccepted.

## Reuse evidence

Reuse an existing result when its tested code and environment still cover the
contract. Record its immutable source and CI/run association and explain why
later edits do not affect it. Opening a PR, marking it ready, or receiving a
new review is not itself a reason to repeat a successful run. Rerun the
affected checks when code/environment changes or the prior version cannot be
established. Do not convert an unrelated result into proof of an untested path.

## Publish the declaration

Put the final evidence and checker verdict in the PR's `## Acceptance` section.
The [PR template](../../.github/pull_request_template.md) defines the three
declarations: evidence, a reasoned `Not needed`, or `Production only` with the
external limitation, owner, and internal account alias. A pure docs or CI-tool
change can name why no product runtime was involved and link its own proof;
do not call a Node checker run a device or E2B runtime acceptance.

For an evidence declaration, name the runtime, state that the model is
scripted, record the full tested commit, name the fixtures, and link the report
or include local-loop item IDs and passed/total counts. UI changes include a
screenshot image link unless a reasoned exemption applies. A `Production only`
declaration is a planned external check, not a production pass.

[`pr-acceptance`](../../scripts/ci/pr-acceptance-check.mjs) checks the declaration
deterministically. It does not replace independent evidence review. Keep CI
green, resolve actionable review findings, and follow the owning issue's batch
merge and exact-merge verification rules.

## Keep the adapter current

Append verified lessons to [common mistakes](common-mistakes.md) and reusable
boundary examples to [probe and fake patterns](probe-mock-patterns.md), with
the source issue/PR and the observation. Update commands in `PROJECT.md` only
after checking the actual implementation. Preserve historical run outcomes.
