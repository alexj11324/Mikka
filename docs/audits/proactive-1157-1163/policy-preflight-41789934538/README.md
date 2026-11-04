# v3 policy preflight 41789934538 — FAIL

This is the complete evidence from the single actual preflight attempt at 2026-11-04 07:06:45.645–07:07:29.081 UTC. The outcome remains **failed** with `preflight_candidate_rejected`. Root independently read the original report before this archive was appended. This record does not replace or reinterpret the earlier failed v2 preflight 41785533094.

## Fixed execution

- Workflow: [41789934538](https://github.com/alexj11324/Mikka/actions/runs/41789934538), attempt 1; job `126440686359`.
- Driver head: `9829404f83610d52a994b42c96289a67e9424337`.
- Application source: `eca0201f8c3ffbb1533a0acbec32c3a0eba91b24`.
- Production deployment: `dpl_5csuJ6ooM6y8PjGaVsWUUkVRUKnE`.
- Baseline `group-route-v0`; explicit candidate `group-contribution-v3`; normal live policy remained `group-contribution-v1`.
- Dataset `group-decision-cases-v2`, comparison `group-decision-comparison-v2`, protocol `group-sequential-v1`.

## What actually happened

All 24 logical observations were collected with their primary receipts. The candidate completed all 12 cases with action accuracy 1, responder accuracy 1, and no recorded quality failure. This is a result on the fixed twelve-case dataset, not a claim of universal routing quality.

The baseline completed 7 cases and produced 4 fully receipted terminal `uncertain` observations. In the remaining `new-member` case, responder step index 0 completed with execution ID `722e1ce4-d2df-4300-b47d-0452c735340b` and provider generation ID `gen_01M6JP3PWA9QTRHBAKRJ2C8S0B` (07:06:56.222–07:06:56.660 UTC). The next responder step, `b0ce5704-9baf-43b1-b18c-11d314926a0c`, has status/failure `unavailable` and a null receipt.

Consequently, `evidenceValid` and `collectionComplete` are true, but `baselineClassifiable`, `valid` and `qualityAccepted` are false. There were 19 completed routes in total. The unavailable step is not an intentional abstention and cannot be counted as one. The candidate's successful cases do not turn this incomplete comparison into a pass. No specific upstream HTTP code or network cause is established by these artifacts.

## Cost and cleanup

| Scope | Attempts | Provider receipts | Unreceipted | Known USD | Complete total USD |
|---|---:|---:|---:|---:|---:|
| Baseline | 20 | 19 | 1 | 0.001192 | Unknown |
| Candidate | 23 | 23 | 0 | 0.001687 | 0.001687 |
| Entire routing decision chain | 43 | 42 | 1 | 0.002879 | Unknown |

These amounts cover only `routing-decision-chain`. They do not represent all chat, Factory, runtime or external-provider billing. The missing receipt leaves one cost observation unknown; it is not zero. The raw JSON retains the original floating-point values and null total without rounding or rewriting.

Normal Smoke login and logout both returned 200; the owner identity and scope were confirmed, and logout was acknowledged. `policyChanged`, `executionPerformed` and `productionAccepted` are all false. This preflight did not create chat messages, dispatch Factory work, or promote the candidate. No rerun was performed while downloading or archiving this evidence.

## Byte provenance

GitHub artifact `13302807382` contains the original `results.json`.

- `artifact.zip`: 10,700 bytes; SHA-256 `598bfaf9715c67a6a9042411dbcf216882f9c8419ac0938f904c38c5015b1920`, matching GitHub's artifact digest.
- `results.json`: 86,308 bytes; SHA-256 `77a027c08d837e2c6a1222c94e80cd148ad2d49f75976c713e04c7321903f4d7`.

The complete ZIP and JSON were downloaded through the official artifact reference. Bounded transfer chunks were length-checked, and the resulting Git blob hashes matched the original remote bytes. Neither file is a truncated tool preview or a reconstructed summary. See `provenance.json` for the exact workflow, release, result and artifact bindings.
