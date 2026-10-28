# Skill effect assessment repair

This candidate repairs the keyword-based effectiveness judgment in #237/#247.
It does not complete real Harness, candidate-artifact or production acceptance.
The original assignment/lineage acceptance gaps remain; Factory release is on
hold. There is no deployment, merge, live provider call, new production SQL,
credential change, data deletion or candidate activation in this repair.

The isolated branch starts at #247 `a3aab96af7a406d85aa46e6a15314788dd2907b4`.
It consumes the parent-supplied #331 source contract from
`bb2a582498c95dcf13e57739e7e0ed866c0e190f` in a separate dependency commit.
The two supplied files were materialized only in this combination worktree:

| File | SHA256 |
| --- | --- |
| `lib/coordinator/decide.ts` | `a6927c2721b09a97bace4f652c2224a60d5d579cad44bb1d322311122d367c16` |
| `lib/coordinator/decision.ts` | `a74bea999aceb37dff95e8d0220647be2fd277b84c730e4e72bd8cc1cd063622` |

Apply the domain repair after that contract; do not replace its owner's writer
with this dependency commit. No Factory 192/193/194/195 implementation, worker
claim/lease path, protocol, enterprise or approval authorization file is edited.

## Behavior and interfaces

`compareDocuments` now computes document/benchmark identities and returns
`status=pending`, `outcome=unknown`, `improved=null`, `noRegression=null`.
Adding every old benchmark phrase, including the fixed prototype guideline,
cannot manufacture an effectiveness result. The fixed benchmark/scorer versions,
failure trigger and security thresholds are unchanged. The prototype document
candidate remains inactive and is not itself a learned improvement.

`createImprovementEvaluator({loadComparison, invokeDecision})` accepts trusted
server dependencies, not HTTP/model-supplied evidence. The collector request
binds user, issue, proposal, fixed benchmark, baseline and candidate digests.
The collector must verify actual run/session/commit/environment provenance,
immutable assigned artifact versions, fixed-task outputs and capture provenance.
The evaluator additionally checks raw artifact/output/image hashes, distinct
runs/sessions, versions, complete fixed cases, capture times, matching environments
and required visual evidence. These mechanical checks cannot prove that a
collector is authentic or that a model understood an image.

The evaluator submits trusted outputs and every available image's actual bytes
to the existing #331 vision-capable decision route. A structured choice is
`improved`, `not_improved`, `regressed` or `unknown`. No confidence cutoff or
human-confirmation fallback is added. The host execution must match the exact
request body, existing model, generation ID and submitted image hashes. A host
receipt proves request/response binding; `image-input-submitted` does not prove
visual understanding. Refusal, malformed/mismatched responses, unavailable
model/collector and insufficient evidence remain unknown/pending. Model output
never authorizes execution, activation, approval or publication.

The server wires the actual `invokeDecision` interface but has no trusted
comparison collector in this frozen baseline. It therefore returns pending
before any provider invocation. A production collector and authorized live
acceptance are explicit remaining integration dependencies.

The append-only proposal ledger stores pending mechanical results. `propose`
returns a separate fresh `assessment`; reads also replace historical keyword
booleans with pending in the response without rewriting the ledger. Handoff
never consumes persisted keyword verdicts: it validates the current Factory
binding and all sources, releases its connection/locks, evaluates, then validates
the current Factory binding, all sources and candidate identity again in the
actual dispatch transaction. A missing/non-improving judgment causes no dispatch.
Independent review, verification and approval remain external existing gates.

## Isolated verification

Run the dedicated workflow command with `IMPROVEMENT_TEST_URL` pointing only at
a loopback PG17 `mikka_improvement` test database. The tests reject other hosts
and database names. They retain unique synthetic schemas; no cleanup is run.
The added semantic regression tests are included in the existing dedicated CI
workflow. Runtime identity, test output, images and decision execution in these
fixtures are synthetic and must not be cited as real model quality evidence.

Coverage includes keyword stuffing; model absence/refusal/unknown/timeout;
all structured outcomes with and without confidence; actual image transport
input and request receipts; mismatched digests/versions/runs/cases/capture times;
historical immutable `improved=true` records; no pending dispatch; source stop
while evaluation waits; five concurrent handoffs with a five-connection pool
and collector reads from that same pool; original assignment/mount/resume and
concurrent proposal/dispatch checks. No provider or external publication runs.

Remote typecheck/full CI, real trusted comparison collection, actual authorized
CLI baseline/candidate execution, merged Factory terminal/lineage fences,
production user flow and sanitized playable PR video remain unverified here.

The subsequent source push passed remote typecheck, semantic PG/HTTP (30 tests)
and daemon transport (6 tests), but full CI stopped at migration ordering.
The seven inherited SQL files were absent from current main and must be new
there; they cannot be treated as applied just because related tables exist.
The follow-up [migration compatibility record](factory/migration-compatibility-20261028.md)
documents unchanged SQL, pinned historical-name recognition and actual PG
upgrade/ledger tests. It does not establish production migration or acceptance.
