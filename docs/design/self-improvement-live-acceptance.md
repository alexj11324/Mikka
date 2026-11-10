# Controlled Skill improvement: live completion plan

This is the historical completion plan for the #316 composition. Its unchecked
work list is not a current implementation inventory. The repository contains
candidate generation requests (`regression.ts`, `factory-bridge.ts`), immutable
registration (`registry.ts`), frozen execution comparison (`evaluations.ts`,
`comparison-collector.ts`) and Factory activation/monitoring (`activation.ts`,
`lib/factory/monitor-probe.ts`). Paths are under `lib/self-improvement/` unless
qualified. Read [self-improvement.md](self-improvement.md) for the source map.

For a new run, follow [acceptance.md](../acceptance.md) and `AGENTS.md`. Model
acceptance covers official Claude Code with `claude-haiku-5-5` and official Codex
with `gpt-6-luna`, independently. The shared acceptance account and its authorized
team workspace supply the production identity. API-key/DeepSeek work is outside
the merge and acceptance gates. UI evidence comes from production-build
screenshots in cloud Linux. Production checks cover the external subscription,
activation and other service behavior that local evidence cannot establish.
The historical checklist below does not establish a completed live result.

> Note (2026-11-03): the fixed trigger of 25 distinct failures or a seven-day-old
> failure named below was later replaced by the Decision API's `propose` answer
> (`lib/self-improvement/proposal-judgment.ts`,
> [decision 2026-11-01-1500](decisions/2026-11-01-1500-self-improvement-and-profile-decided-by-decision-api.md)).

Recorded status on 2026-10-26: implementation in progress. User direction: repair the failed
acceptance requirements until the complete feature passes. This extends the
earlier synthetic rehearsal; it does not relabel that rehearsal as acceptance.
Tracking: #237; composed delivery PR #316; source PRs #238/#247.

## Observable success

| Requirement | Evidence required |
| --- | --- |
| Real feedback and immutable provenance | Authenticated pre-merge (local/Docker production build) and production reads of a real CLI run, its feedback, scorer version, exact Skill bytes and device receipt/mount record |
| Failure-derived candidate | Unchanged 25 distinct failures or seven-day trigger, one logical proposal, real model candidate commit derived from those failure reports, only the allowlisted Skill file changed |
| Real fixed comparison | Baseline and candidate use identical frozen task cases, evaluator/threshold digest, Harness/model/policy, repository fixture and actual daemon execution; candidate improves with no regression; deliberately wrong output fails |
| Independent Factory gates | Separate real execute/review/verify sessions bind the exact candidate SHA, artifact digest, evaluation and source scope |
| Human approval and activation | Existing authenticated evidence read and actual human approval authorize `activate_skill` for that candidate/version/scope; missing, stale or revoked approval is rejected |
| Monitoring and recovery | Existing Factory monitor reads the active artifact and a subsequent mounted run; a real failure creates the existing incident flow, withdrawal stops further execution, and recovery is verified against a freshly approved version |
| Complete delivery | Exact-head CI, independent source/security review, pre-merge production-build check, production user flow and sanitized playable video attached to the delivery PR, read back successfully |

## Existing boundaries to retain

Keep current issue/workspace authorization, native Coordinator behavior, durable
Factory task/attempt ownership, candidate fences, immutable evidence ledgers,
browser-human approval, side-effect reservation/reconciliation, and existing
monitor incidents. Feedback remains untrusted; silence stays unknown. The
synthetic document comparison retains its synthetic label and cannot authorize
activation. Candidate content cannot edit benchmark, evaluator, thresholds,
permissions or model budgets.

Use the existing `mikka-builtin` registry and `single-skill-md-v1` format for one
target, `lib/self-improvement/skills/run-report/SKILL.md`. Preserve the old baseline
version and raw-byte digest. A candidate is a canonical complete SKILL.md fetched
from its exact committed repository source, registered immutably and bound to the
existing proposal/Factory candidate. Evaluation selection is separate from an
approved active selection; historical provenance remains readable after withdrawal.

## Host cost configuration

The `skillModelEvaluation` deployment switch controls paid semantic comparison
(`lib/deployment-switches.ts`, `registered-evaluation.ts`). Its PostHog gate is
`mikka-skill-model-evaluation`; `MIKKA_SKILL_MODEL_EVALUATION=1` is the legacy
fallback when that gate has no answer. With the effective switch off, a valid
comparison remains pending with `decision_model_disabled`, without a semantic
judgment call. This replaces
the earlier hardcoded false, which made the real assessment path unreachable
regardless of host configuration.

This is the AGENTS.md exception for real model spend, not an approval or a new
automatic activation path. It controls the semantic comparison only: benchmark
run dispatch still uses its existing explicit commands and admission checks.
A comparison is requested through the existing explicit `compare_evaluation`
action; reading status does not request paid judgment. The comparison still
requires the frozen task set, both observed arms, exact
mount/source/evidence bindings and current authorization. Existing billing and
model-admission scope is unchanged. Independent review/verification and the
candidate-bound human activation approval remain required. The unrelated
Agent Kit live-evaluation flag does not enable this feature.

No live paid model invocation or Skill activation was performed to verify this
configuration change; focused tests exercise the production constructor and
collector with an explicitly synthetic judgment transport.

## Ordered work

- [x] Compose #238/#247 and main, preserve native authorization/reconciliation,
  order unpublished migrations by dependency, retain mandatory DB/HTTP coverage.
- [ ] Reconcile subsequent main changes and complete the current-task/attempt
  claim negative controls; remote CI validates the combined source.
- [ ] Replace fixed-template production proposal generation with a real Factory
  execute task built from immutable failure/report references and bounded,
  explicitly untrusted feedback.
- [ ] Register the exact candidate commit's allowlisted canonical bytes; wire
  candidate and active selection through the existing claim/resume/heartbeat
  provenance checks.
- [ ] Freeze the real run-report benchmark/evaluator before candidate generation;
  persist trusted baseline/candidate assignments and daemon mount evidence;
  compute comparison from real output and reject tampering/missing evidence.
- [ ] Extend existing Factory approval/publication/monitor contracts for exact
  Skill activation, withdrawal and observed adoption. Preserve transaction locks
  through the activation side effect and publication completion.
- [ ] Repair only the existing UI paths needed for actual feedback, evidence
  review, approval and terminal question recovery; keep the current chat/shell.
- [ ] Run cloud PG/HTTP/CI and independent review, fix demonstrated failures,
  freeze the exact commit in a local/Docker production build with an isolated
  database (branches have no Vercel Preview), then use actual OAuth and the
  local updated daemon.
- [ ] Collect real qualifying failures, generate and evaluate a real candidate,
  obtain the candidate-bound human approval, validate activation/monitor/recovery,
  repeat the production user flow and attach/read back the playable video.

## Verification and failure conditions

Source tests run locally only where no server is needed. Builds, type checks,
databases and browser application environments run remotely. The local daemon
uses actual authorized CLI sessions against the fixed cloud deployment.

Each independently reviewable concern receives a focused commit after its checks.
The final branch and deployment remain fixed during acceptance. Missing trusted
mount evidence, mismatched artifact/source/benchmark identities, source revocation,
stale task/attempt, regression, absent independent sessions or absent real human
approval fail closed. A passing model self-report, synthetic fixture or green CI
cannot substitute for the row of runtime evidence it does not exercise.

## Integration scope

Callers: self-improvement HTTP/Coordinator tools, Factory dispatch/check/approval/
publication/monitor, actual device claim/heartbeat/resume/chunk ingestion, daemon
adapters/RunContext/verification, current feedback/approval UI. Tests: immutable
PG/HTTP boundaries, required database inventory, real benchmark negative controls,
daemon mounting, actual deployed OAuth/user path and recorded acceptance. Config:
an isolated test database, existing cloud identity and secrets delivered
from Infisical; no local credential files. Exports/protocol: only the shared artifact/evaluation/mount
fields needed by these concrete consumers.
