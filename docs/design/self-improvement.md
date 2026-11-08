# Controlled Skill improvement

This reference maps the implemented controlled Skill improvement path for
backend and daemon maintainers. Tracking began in #237 / MIK-103. Historical
candidate evidence remains in [validation](self-improvement-validation.md) and
[assignment wiring](self-improvement-assignment-wiring.md).

## Feedback and proposals

A person submits feedback on a finished run. The server freezes the scorer,
report, run/session and available Skill provenance in append-only ledgers.
Feedback notes are bounded untrusted evidence. Silence and missing data remain
unknown. Worker reports alone do not establish independent verification.

`lib/self-improvement/store.ts` partitions failures by the server-owned bucket,
rechecks current issue/run access and locks sources before writing. The
[Decision API](decisions/2026-11-01-1500-self-improvement-and-profile-decided-by-decision-api.md)
decides whether eligible distinct failures justify a proposal. No answer returns
`decision_unavailable`, a negative answer returns `decision_not_ready`, and
neither creates a proposal. The code caps each bucket at one new proposal per
24 hours. The benchmark's 25 training cases are independent of that judgment.

`regression.ts` builds a `feedback_candidate_request_v1` from immutable source
IDs and the builtin baseline. `store.ts` persists it as
`awaiting_model_candidate`, with a `not_evaluated` result. `factory-bridge.ts`
hands the request to an authorized Factory execute task. The generated candidate
is limited to `lib/self-improvement/skills/run-report/SKILL.md`.

## HTTP and Coordinator entry points

`app/api/self-improvement/route.ts` uses the existing API session/PAT resolver,
acting-user scope and record-level workspace-token checks. POST requires the
exact request origin and a streaming body no larger than 16 KiB. Strict command
schemas live in `lib/self-improvement/schema.ts`.

| Action | Purpose |
| --- | --- |
| `feedback`, `propose` | Record a verdict or request the server's proposal judgment |
| `select_baseline`, `rehearse` | Select the builtin on a queued run or dispatch a baseline rehearsal atomically |
| `handoff`, `register_candidate` | Link Factory execution and register its exact committed candidate |
| `freeze_benchmark`, `dispatch_training` | Freeze a private benchmark instance and dispatch training cases |
| `begin_evaluation`, `dispatch_evaluation`, `compare_evaluation` | Bind both arms, dispatch cases and request the comparison |
| `select_active` | Select the approved active version for an eligible run |

GET accepts `runId` for scores/proposals or `proposalId` for linked Factory
state. Responses use `Cache-Control: private, no-store`. Coordinator tools and
durable steps in `workflows/coordinator/factory-tools.ts` and `factory-steps.ts`
call the same services. `components/workspace/self-improvement.tsx` provides
run feedback in the thread UI.

## Immutable source and execution evidence

`packages/protocol/src/skill-artifact.ts` owns the implemented artifact and
assignment-receipt schemas. `assignments.ts` records the selected bytes at the
actual claim boundary. An assignment receipt means the server prepared those
bytes. It does not prove delivery, mounting or execution. Missing historical
provenance remains `unrecorded`.

The daemon verifies the assignment bindings and exact Skill bytes before adapter
launch. `skill-mounts.ts` accepts a separate mount record through authenticated
device completion, binding receipt, version, digest, session, live lease and
execution/runtime evidence. Claim, resume and heartbeat preserve their existing
source and lifecycle checks.

`registry.ts` registers canonical bytes from the exact committed candidate and
revalidates its Factory/run/source bindings. Its builtin candidate path and the
workspace Skill branch (`team-skills.ts`) share immutable version resolution.
The earlier [source-boundary proposal](self-improvement-skill-source-contract.md)
is historical coordination material.

## Comparison and activation

`report-benchmark.ts` owns the frozen reporting corpus, evaluator and verification
command described in [the benchmark reference](self-improvement-benchmark.md).
`evaluations.ts` freezes instances and assignments. `comparison-collector.ts`
resolves authenticated run, artifact, mount and output evidence for both arms.
Model text cannot supply trusted provenance or change the evaluator.

`registered-evaluation.ts` gates paid semantic judgment through the
`skillModelEvaluation` deployment switch. Its PostHog key is
`mikka-skill-model-evaluation`, with legacy fallback
`MIKKA_SKILL_MODEL_EVALUATION=1`. A disabled effective switch returns
`decision_model_disabled`. Reading status does not request judgment.

`activation.ts` plugs `activate_skill` into the existing Factory publication
adapters. It requires the exact candidate, immutable artifact, passing evaluation,
current scope and candidate-bound human approval. Factory monitoring reads the
activation and subsequent adoption evidence. Withdrawal invalidates eligibility
for the withdrawn version. A proposal, synthetic comparison or model report
cannot authorize activation.

## Verification and acceptance

The maintained source suites are `test:self-improvement-unit` and
`test:self-improvement-semantic-source`. Database coverage is in
`test:self-improvement-db` and `test:skill-semantic-db`. Commands are defined in
`package.json`. Builds, type checks and database/runtime checks run in cloud
Linux or CI under `AGENTS.md`.

Use [acceptance.md](../acceptance.md) for a fixed revision, application origin,
database/daemon environment and retained evidence. Live model acceptance covers
official Claude Code with `claude-haiku-5-5` and official Codex with
`gpt-6-luna` independently. Production uses the shared acceptance account and its
authorized team workspace. No API-key/DeepSeek leg gates completion.

The [earlier live completion plan](self-improvement-live-acceptance.md) records
its original checklist. This source inventory does not establish a completed
production candidate, activation or recovery run.
