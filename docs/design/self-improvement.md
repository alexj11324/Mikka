# Controlled Skill improvement

- **Status:** draft implementation, 2026-10-25
- **GitHub / Linear:** #237 / MIK-103; related #192–#195, #208, #230, #232
- **Owner thread:** Backend & Infra, controlled self-improvement

## What the user does

Submit feedback on an existing finished thread, inspect its immutable score,
and request an improvement proposal after enough distinct failures accumulate.
The first implementation produces a Skill document diff and a fixed synthetic
offline comparison. A proposal never activates a Skill or authorizes an action.

## Where it lives

Authenticated backend API only; no UI or model calls. Main `c0f702f` has run
reports and sessions but no feedback/scorer ledger or content-pinned Skill
usage. Protocol Skill refs carry id/name only and are not wired into main's
run schema. Historical usage is explicitly `unrecorded`, never backfilled as
fact. #232 remains the Skill registry owner.

## Interfaces and file boundary

- `POST /api/self-improvement`: strict action `feedback` with eventId, runId,
  verdict (`positive`, `negative`, `unknown`) and bounded untrusted note;
  or action `propose` with runId. The browser session supplies identity.
- `GET /api/self-improvement?runId=...`: authorized scores/proposals for that
  run's owner, issue and agent/repository bucket. No caller workspace or policy.
- `lib/self-improvement/{contract,scorer,regression,store,http,server}.ts`:
  immutable server-owned scorer, fixed trigger, transactions, allowlist and
  synthetic comparison. No shell, network, model or publication adapter.
- `drizzle/20261025070600_self_improvement.sql`: separate append-only ledgers;
  no changes to shared Factory, protocol, registry or permission contracts.
- `lib/issue-access.ts`: the identical optional transaction executor already
  present in #192's candidate; no permission-rule change. Parent must dedupe it.
- Tests and `.github/workflows/self-improvement.yml`: source tests and actual
  isolated PG17/HTTP checks. Full build/typecheck remain existing remote CI.

## Rules and controls

R-01/02/10 unchanged; no frontend. Feedback is an untrusted signal, not truth,
permission or executable instructions. Negative feedback or a failed report
verification produces a failure signal; silence/missing data is unknown.
Scores freeze scorer version/digest, report digest, session, commit when
available, timestamps and missing Skill provenance. Reports are worker
assertions, not independent verification evidence.

Evidence stores source IDs without lifecycle foreign keys to live runs/issues,
so existing Agent/run deletion remains available. Read access still requires
a live owned run and current issue access. No deletion is performed here;
retention and any later privileged erasure path belong to #210 and require
separate coordination. Notes remain private, bounded, and untrusted.

The fixed trigger is 25 distinct, not previously proposed failed runs per
owner/issue/agent/repository/scorer/target, or oldest failure aged seven days.
It is not an evaluation threshold and is not editable through the API or a
candidate. Transaction locks and source claims make replays/concurrency
idempotent. Every operation rechecks existing issue access and current run
stop state. Cancellation/deletion/revocation prevents further writes/reads.

The only target is the bundled, inactive `run-report` rehearsal Skill document.
The service appends one server-authored reporting guideline; it never copies
feedback into instructions. The document is not installed or claimed to have
been used by historical runs. This is an offline candidate boundary pending
#232's digest-pinned usage contract. Baseline/candidate bytes, digests and a
server-generated diff are persisted. No arbitrary path or candidate input.

The fixed synthetic benchmark tests the document's reporting requirements
using the same cases and scorer for both versions. It is a deterministic
document-contract rehearsal, not a model-quality benchmark or real Harness
acceptance. A passing comparison stays `awaiting_independent_review` and gives
no #193/#194 gate eligibility.

## Existing owners and integration delta

#195 owns incident/issue dedupe; this adds no incident, issue, webhook or wake.
#192 owns stage/candidate state. #193 and #194 continue to require actual
candidate SHA/repository/environment/scope plus independent runs and human
approval. This proposal has content digests, not a fabricated commit: the
parent must submit its reviewed diff via existing candidate creation and
re-run both gates after a real commit. #208 remains external side-effect
ledger owner; this service has no external side effects. #230's centralized
policy, model budgets, approval and branch protection remain untouched.
#232 requested future delta: trusted run assignment receipt containing Skill
id, immutable version, digest and source; until then usage stays unrecorded.
The [minimal proposed reference and trust boundary](self-improvement-skill-source-contract.md)
are coordination material only. 现状（非决定）：#232 has no implemented receipt
path yet.

## Out of scope

Model weight updates, automatic adoption/merge/deploy, active Skill writes,
new scheduler/registry/approval system, arbitrary code or config patches,
candidate-modified scorers/cases/thresholds, paid models, new credentials,
memory-based authorization and deletion of test or application data.

## Done when

Real PG17 and HTTP cover persistence/restart, ten concurrent replays, payload
conflicts, tenant/issue/agent/repository separation, unknown signals, frozen
versions, trigger boundaries, candidate allowlist and negative regression.
Record actual commands/results separately from synthetic run/report fixtures.
Remote CI, independent code review and actual fixed-version Mikka runtime
acceptance remain required. Parent coordinates production deployment and a
sanitized real acceptance video on the PR; tests cannot close these gates.

## Research

[Warp documentation](https://docs.warp.dev/factories/measure-and-improve/self-improvement/)
describes per-scorer failure aggregation and reviewed improvement PRs.
[Warp engineering article](https://www.warp.dev/blog/self-improving-software-proactive-agents)
describes Skill improvement, not model-weight RSI.
The verified [demo Skill](https://github.com/warpdotdev-demos/issue-triage-loop/blob/main/.agents/skills/improve-triage-skill/SKILL.md)
uses human feedback and PR review. Its weak-positive interpretation of silence
is not adopted here; absent feedback remains unknown.
