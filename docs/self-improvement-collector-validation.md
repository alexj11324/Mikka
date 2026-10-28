# Registered Skill comparison collector candidate

This source consumes existing #316 case/arm/mount/version/settings contracts
and main artifact storage. It does not add a registry, queue, schema migration,
permission, approval or activation path. The active #316 writer is unchanged.
Live model evaluation is explicitly OFF in `lib/self-improvement/server.ts`.

`loadSkillComparison` is the actual server `loadComparison` dependency of
`createRegisteredSkillEvaluator`. It reads current owner/issue authorization,
the exact frozen evaluation (or refuses ambiguity), registered immutable Skill
versions, current Factory candidate/withdrawal state, every fixed case in both
arms, and each actual run/session/selection/receipt/mount/execution binding.
It preserves the fixed benchmark definition, source commit, requested/observed
Harness model, policy, fixture digest and verification command. It never uses
the candidate's source commit as the benchmark execution source commit.

Outputs are actual persisted submit summaries bound to those runs. Available
Markdown/HTML versions are additional observations, read through the existing
artifact_versions/R2 storage contract: owner-derived key, version, raw content
hash, size and capture window. No document URL, HTML program or linked image
is executed/fetched. Text does not prove visual understanding, health, authorship,
correctness or authorization. This fixed report benchmark is text-only; no
trusted image collector is claimed. The text reader follows the checks supplied
by #192 `bee2c0e5f22fedf0815d19048c9b1c53722e9695` (source SHA256
`77aa74a56e883f0fa5da5af343368778098078c314960aa90de06d9ef3ce0f14`),
adapted to benchmark case ownership rather than copying Factory-attempt joins.

Before object I/O the collector bounds version count and total text bytes;
actual bytes are checked again while reading. These are transport safeguards,
not score thresholds or provider budget changes. Current access and all source
rows are re-read after storage I/O. No database connection/lock crosses I/O or
model awaits. The evaluator revalidates again after an injected model call.

The same shared structured judge as the prototype path uses #331's actual
invokeDecision contract. `skill-effect-model` v1 pins its question digest.
Unavailable evidence/model yields pending/unknown. Model OFF still exercises
collection and returns `decision_model_disabled` with the bound evidence digest;
it never reports improved. Assignment or execution envelopes do not prove
independent quality and cannot approve or publish anything.

Two hash schemes are deliberately separate: `baselineDigest/candidateDigest`
remain the canonical proposal document-body digests used by the old bridge;
`artifactBaselineSha256/artifactCandidateSha256` identify raw mounted Skill
bytes including frontmatter. A different registered candidate cannot satisfy
the prototype's identity checks. The old prototype handoff is therefore not
claimed as #316's complete generation/evaluation/approval/activation integration.
Its owner must connect this reader/judge to the existing registered comparison
path and preserve the original frozen evaluation IDs and gates.

Unmodified dependency sources were materialized only in this independent tree:

| Source | SHA256 |
| --- | --- |
| main `dd6d8d4` `lib/artifacts/storage.ts` | `001ee08df0b59d35f8acc241fc5796d63ee25cfb7d1dc2fc6e3cf58d907088bf` |
| #316 `4c1255d` `lib/self-improvement/report-benchmark.ts` | `32bef43e57d9972446c0adc16d9f96c8e02aa1a30baa026c864d828192c49a6a` |

`aws4fetch` version/integrity are taken unchanged from that main lockfile.
Consume the domain adapter against those owners' modules; do not overwrite a
newer shared writer with these dependency copies.

Pure tests cover incorrect owners, commits, instances, cases, arms, receipts,
mounts, settings, versions, artifact bytes/keys/times, post-I/O revocation,
transport caps, model OFF and post-model drift. The new PG17 test was separately
statically reviewed: it only creates a fresh random projection schema and tables,
inserts synthetic rows, performs SELECTs and leaves one mount deliberately
tampered by UPDATE. Teardown closes only its own connections. It invokes no
historical migration, deletion, filesystem cleanup, container operation, object
network request or provider. It is a read-contract test, not actual CLI/quality
or production acceptance. All fixtures/resources remain retained.

Historical destructive suites/full CI remain suspended and are not counted as
passing acceptance. Production/Staging SQL, live provider evaluation, complete
#316 integration, actual artifact/lineage verification and PR video remain pending.
