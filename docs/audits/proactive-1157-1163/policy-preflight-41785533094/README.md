# Candidate policy preflight 41785533094 — FAIL

This is the unchanged result of **one** normal-owner production preflight. The root reviewer independently read the complete original report, both policy summaries, the failing candidate case and its three provider receipts before this interpretation was added.

## Fixed run

- Workflow: [Temporary group policy preflight, run 41785533094](https://github.com/alexj11324/Mikka/actions/runs/41785533094), attempt **1**, job **126426685111**.
- Workflow commit: `11560bdc245cd4c881326288e2b9a38ea21adf99`.
- Application source: `aee3b8d23fc1431b4c0f6c98d9852d1402bc723e`.
- Deployment: `dpl_4hjwCkNCz8TNMYsmK3zbgKHCXAFe`.
- Observation window: **2026-11-04 06:26:57.637–06:27:36.496 UTC**.
- Live routing policy remained **group-contribution-v1**. The explicit replay compared unchanged **group-route-v0** with candidate **group-contribution-v2** under **group-decision-comparison-v2**.

## Actual result

**FAIL — `preflight_candidate_rejected`.** Collection and evidence validation completed; the candidate failed one responder requirement. This is a real quality failure, not a missing receipt or an outer-summary validation failure.

| Measurement | Baseline v0 | Candidate v2 |
| --- | ---: | ---: |
| Fixed logical cases observed | 12 | 12 |
| Complete routes | 8 | 12 |
| Explicit uncertain abstentions | 4 | 0 |
| Action accuracy, denominator 12 | 5/12 | 12/12 |
| Responder accuracy, denominator 12 | 7/12 | 11/12 |
| Actual provider calls / receipts | 20 / 20 | 22 / 22 |
| Known routing-decision-chain cost (USD) | 0.001252 | 0.001610 |

The collector retained **24/24 logical observations**, **20 complete routes**, and **42/42 distinct provider receipts**. There were no unreceipted, unknown-cost or omitted calls. Outer `valid`, `evidenceValid`, `collectionComplete` and `baselineClassifiable` are true; `qualityAccepted` and the source comparison's `decisionReviewReady` are false.

Total observed cost is **USD 0.002862 for the routing decision chain only**. It is not a total chat, Factory, Cloud runtime or provider-account bill.

The baseline's four negative-case uncertain results remain recorded failures/abstentions. They are not successful silence and are not counted as completed routes. Other baseline action, responder and report-timing failures remain in the original report.

## Sole candidate mismatch: independent-views

The candidate selected `reply` with reason `independent_contributions`, but the host route contained only the UI member `00000000-0000-4000-8000-000000000001`. The fixed case requires the two independent UI and Testing perspectives. The projection therefore records one selected responder and the failure is `independent-views / responder`.

The three actual candidate phases all completed with real receipts:

| Phase | Execution ID | UTC interval |
| --- | --- | --- |
| intent | `3f383755-2d2e-49c8-9524-9b9830e9dbb7` | 06:27:29.438–06:27:29.861 |
| responder | `d67b39e4-7557-4230-b33f-641d084dd3b6` | 06:27:30.114–06:27:30.480 |
| responder | `f38c2568-9c73-475c-b000-3f8272ff1a9f` | 06:27:30.733–06:27:31.230 |

Their recorded cost is USD 0.000214. The report stores the final route and phase receipts, not the raw provider answer; it does not establish which internal answer enum caused the missing second responder. The baseline selected three members, including an extra Coding perspective, and also failed this case.

## Scope and cleanup

Normal Smoke login returned 200; the session identity and owner scope were confirmed. Normal sign-out returned 200 and was acknowledged. The report records `policyChanged=false`, `executionPerformed=false` and `productionAccepted=false`. This preflight did not promote the policy or prove the chat/Factory execution scenarios.

No rerun was triggered. The live policy remains v1. Any corrected candidate must be separately versioned as v3 and evaluated prospectively; this v2 run remains failed. No original case label, receipt or report has been changed.

## Byte preservation

- `artifact.zip`: **10,478 bytes**, SHA-256 `a8378bd68504030ef1876c72f7415bcfd160adad9a091407d745dc60506de33d`; matches GitHub artifact 13300887960's digest.
- `results.json`: **86,314 bytes**, SHA-256 `088f82d7808246613c8340a4a712ff659bf060fae9f54716e887af234826b63e`.
- Both Git blob hashes were verified against the complete files in the owned VM. Bounded transport chunks were reassembled and length/hash-checked; truncated tool output was not treated as a full file.
