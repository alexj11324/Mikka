# PR1208 v3 candidate: scoped offline verification

Candidate product commit: [7a4ab4d1fadfc58ac4b759f08e4c41a9a0647c00](https://github.com/alexj11324/Mikka/commit/7a4ab4d1fadfc58ac4b759f08e4c41a9a0647c00). Final test correction: [431b986cb29743c4f10c844d5da8b646daeacefe](https://github.com/alexj11324/Mikka/commit/431b986cb29743c4f10c844d5da8b646daeacefe), tree `875e232fac0dc52ed22dacd30e17c5babc84e76e`. Base `aee3b8d23fc1431b4c0f6c98d9852d1402bc723e`.

This is offline implementation/compatibility evidence, not a new model-quality acceptance. No provider was called by these tests. Live remains group-contribution-v1; archived v0/v1/v2 requests and the prior failed real comparisons remain unchanged.

## Original optional-selector red → green

Isolated cloud Linux directory: `/vercel/Mikka-group-candidate-v3`. The changed prompt contract asks for separately requested roles/perspectives not yet represented, even with overlapping skills; it retains end, uncertain, authorized choices and the existing call/responder caps. The scripted test uses Research/Reliability/Writing roles rather than hard-coding the fixed evaluation’s UI/Testing pair.

Red command:
```sh
node --import tsx --test --test-name-pattern='v3 independently|historical v0/v1/v2' lib/coordinator/group-decision-sequence.test.ts
```
Command `cmd_165103d86ac14948887b8df2ec49`, log `/tmp/group-v3-red2.log`, exit 1: the new optional-selector contract rejected the old wording “confirmed responders cannot cover”; the historical byte test passed. This red tests the prompt contract, not the model’s reasoning.

Full green command:
```sh
node --import tsx --test lib/coordinator/group-contribution.test.ts lib/coordinator/group-decision-sequence.test.ts lib/coordinator/group-decision-quality.test.ts lib/coordinator/group-decision-replay.test.ts lib/deployment-switches.test.ts scripts/ops/group-production-acceptance.test.mjs
```
After the product patch: `cmd_c7963f57a12440a08847e7f107ed`, 57 passed / 0 failed / 0 skipped.
After the independent-review test correction below: `cmd_acde74ca665146cabe23d017d04f`, log `/tmp/group-v3-history-fixed-green.log`, 57 passed / 0 failed / 0 skipped, exit 0.

## Independent review: historical failed cases must not swallow assertions

Review found that a requestDigest assertion inside the mocked invoke callback could be converted to GroupJudgmentPendingError, which an archived uncertain-case test expected. The correction collects every actual reconstructed digest inside the callback and performs deepEqual outside the route’s pending-error boundary.

A temporary, uncommitted mutation changed only the first v0/small-talk expected digest from `270f…` to `070f…`:

| Placement | Exact command ID | Outcome |
|---|---|---|
| Original inside-callback assertion | cmd_0e2b19ae9fed406cba226147f705 | Incorrectly passed, confirming the test defect |
| Corrected outer array assertion, same wrong digest | cmd_219f7b3130db4d818288f96d99dc | Failed with explicit actual 270f… / expected 070f… mismatch |
| Authentic digest restored | cmd_acde74ca665146cabe23d017d04f | All 57 scoped source checks passed |

The two mutation runs used `--test-name-pattern='historical v0/v1/v2 offline'`. Logs: `/tmp/group-v3-history-mutant-old.log`, `/tmp/group-v3-history-mutant-new.log`. No corrupted digest, label or report was committed.

## Historical request provenance

The test reconstructs 63 requests offline over 36 fixed logical cases, using scripted answers to reproduce the archived host state. Its expected hashes come from saved real provider receipts; the offline pass is not 63 new inferences.

| Policy | Offline cases / request digests | Archived real source |
|---|---:|---|
| group-route-v0 | 12 / 20 | [Preflight41785533094](https://github.com/alexj11324/Mikka/actions/runs/41785533094) |
| group-contribution-v1 | 12 / 21 | [Core41778455749](https://github.com/alexj11324/Mikka/actions/runs/41778455749) |
| group-contribution-v2 | 12 / 22 | [Preflight41785533094](https://github.com/alexj11324/Mikka/actions/runs/41785533094) |

Core41778455749 original sanitized JSON: 109597 bytes; SHA256 `05dc85a33db2a928e45c6cadcd13a85003131df8450404deb0f13363af50ac98`.
Preflight41785533094 original report: 86314 bytes; SHA256 `088f82d7808246613c8340a4a712ff659bf060fae9f54716e887af234826b63e`; immutable Git blob `1d029058dd9a9b7bd7ab8f6e5cb07b59ceb0f5e8`.

Both real reports remain failed. In the later report, the candidate completed all 12 cases but selected only UI for the requested UI+Testing independent views; responderAccuracy was 11/12 and qualityAccepted=false. No dataset, label, baseline prompt or quality gate was changed to erase this failure.

## Real isolated database and static checks

```sh
REQUIRE_DB=1 node --import tsx --test lib/coordinator/group-decision-quality.db.test.ts
```
`cmd_35f92bba29364432aca97f6230ed`, log `/tmp/group-v3-pg.log`: real isolated PostgreSQL 17, 2 passed / 0 failed / 0 skipped, exit 0. It checks scoped traces, feedback/membership privacy and frozen policy across live rollback/retry. The final child commit changes only a test, so this product-byte-matched PG result remains applicable.

`cmd_794a5dc3ff6c48b1824dc3c8c902`: tsrs --noEmit, oxlint --deny-warnings on all nine changed files, git diff --check; exit 0.
After the test-only correction, `cmd_92012b72658e47978c6be6df742f`: tsrs --noEmit, oxlint --deny-warnings on group-decision-sequence.test.ts, git diff --check; exit 0.

The next quality decision requires a separately authorized, fixed-source 24-case real comparison. The prior v2 promotion object 082778 remains inert.
