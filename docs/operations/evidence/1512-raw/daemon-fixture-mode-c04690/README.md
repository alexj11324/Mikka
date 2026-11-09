# Daemon fixture executable modes — checkpoint 15

This is an additive evidence checkpoint for issue #1512. It preserves the first main daemon release failure, the exact two-mode repair, local before/after integration and seal evidence, independent review, and bounded observations of the initial release pipeline. It does not establish production acceptance or a completed release of the repaired candidate.

## Sources and published candidate

- Failed main M1: `01a6bfb3a6c537e2b466911f57429f109b418aa8`, tree `8c5c12ea993533403d13e21dc75647bb28022767`.
- Actual failed daemon run/job: `42544539939` / `128926576137`, before package acceptance, exact-main CI gate, evidence upload and npm publication.
- Local same-tree counterfactual baseline: `df87eb4b8d2952ed3e1aed5ee740ff1231608594`; local fixed commit: `5975e42ef3436a53546948b556166777d1b0be9d`. These local commit identities are not production main.
- Root reports GitHub verification of actual PR #1799 head `c04690ff2c337886ea18e7a4fa73509ebff6de32`, parent M1, tree `a69946cdb08bceb994e11b3278572bea5e7e63c9`. Its file list is exactly the two fixture paths below, zero additions and zero deletions; both are `100755`. That tree matches the independently tested local fixed tree. This archive preparation did not repeat network verification.

The two paths are `packages/daemon/test/fakes/fake-claude-generation-abort.mjs` and `packages/daemon/test/fakes/fake-codex-generation-completion.mjs`. Each changes only `100644` to `100755`. Their blobs remain `09e0751562d1164cb3c0ba67fe7e4bc971dc3116` and `2b4fd7946c39a83eac97def4bab1cf0839802a3b`. Product code, tests, seal guard and ignore rules are unchanged; Git file-mode checking remained enabled.

## What the local regression establishes

Before the repair, the same seven actual adapter/SDK cases pass but leave exactly two tracked mode changes. The unchanged actual seal CLI then fails at `evidence.mjs:108` with `releaseCheckoutDirty`. After recording both executable modes, the same seven cases pass, the tracked checkout remains clean and the unchanged actual seal CLI succeeds. A separate supported `local-drill` seal-and-verify also succeeds.

The real failed CI log did not print its changed-file list. The specific causal attribution comes from the same source tree, both test-file markers in that job, deterministic local mode changes and identical guard rejection. It is not a claim to have read an unlogged production filesystem diff.

The CLI test uses locally supplied GHA-shaped environment values, local snapshot/fix SHA and `runId=0`. Its generated `buildKind=github-actions-main` is fixture output, not GitHub-issued release authority or production evidence. The separate API artifact uses `buildKind=local-drill`. Both use a minimal offline artifact and SBOM; neither substitutes for full package acceptance, actual release CI, npm publication, registry verification or real provider acceptance.

The independent reviewer established that modes participate in the worker hash: base `68271f9890a0926ab8bc0ada6582c1cbad992a8e`, fixed `819b2a0da6d6a8f78ff33586fadeb4ade301834a`. Preserve normal exact-main, candidate, original-file conservation, both subscription and runtime-refresh gates. No hash scope was changed to avoid those gates.

## Release state and prepared dispatch boundary

At the root status notice used for this freeze, PR #1799 CI and M1 E2B `await-web` were still pending. This local preparation performs no status poll and records no new production PASS. The included E2B receipt establishes private candidates and build cleanup only: it explicitly does not establish subscription execution, public-template publication, production runtime refresh or final release cleanup. An early Web success or a skipped job cannot establish those later gates.

`production-01a6/controlled-failure-dispatch.json` is an unexecuted request prepared for M1. The associated prepared ops commit is `19c0064890f4012e1f5e03605e663ec6103689f9`; the preserved record says `published=false` and `dispatched=false`. Work was held after M1 daemon publication failed. The old payload must not be replayed as if it were current: any later authorized execution must first be rebound to the actual subsequent main and its required release conditions. No new ops publication or workflow dispatch occurred here. The retained merge record still has production cases `0` and issue closed `false`.

## Publication boundary and excluded originals

The 19 local evidence files plus their original review index, the independent review, three existing public release projections and two existing merge/prepared-dispatch records are copied byte-for-byte: 26 originals. README and `publication-boundary.safe.json` explain their limits. `checkpoint15-index.safe.json` records every payload byte count, SHA-256 and Git blob hash, the additive evidence parent and the root source-binding notice. Original paths inside copied JSON are provenance references and are not claims that excluded local content was uploaded.

No checkout, private full log/API envelope, raw candidate directory, original E2B candidate JSON or ZIP is included. The following retained hashes identify excluded material only:

| Excluded material | Bytes | SHA-256 or Git tree |
| --- | ---: | --- |
| Full daemon job log | 107424 | `f48d70bd2791a0bb0932f242bd76b93846f213b121efac1bec45a5a84515d1fc` |
| Raw E2B candidates.json | 330055 | `195266b921b74039325f76483e5d94c790d5bb3fb1bfbe536d5cff86e34c2eed` |
| Original E2B candidate ZIP | 46283 | `bcf688d11ee3c0f8037366f8bf1898c4443e50ec3a12a5b86a0e2a9b85f321d3` |
| Original E2B build-cleanup ZIP | 268 | `07d63812c21f3c24f9c8575bd8e5edaf1fb305a55ba02c6070b430b60eaa0cab` |
| Original E2B build-cleanup JSON | 145 | `fab563bae165032f22e2cc86e011e9db7f7ecb52fe107a3229b181724486695b` |
| Local baseline checkout | — | tree `8c5c12ea993533403d13e21dc75647bb28022767` |
| Local repaired checkout | — | tree `a69946cdb08bceb994e11b3278572bea5e7e63c9` |

Additional private API-envelope hashes remain in the existing closed failure projection. The minimal local candidate directory is excluded; its two-file inventories are retained only through the selected frozen seal manifests. Raw originals are not redacted or overwritten. Credential/email screening reports field locations without matched values; no unresolved pattern hit was found in the selected payload.

This checkpoint was prepared locally without network access, new tests, source or root-index edits, CI reruns, model calls, cloud resources or changes to GitHub refs. The daemon failure remains a failure and final production acceptance remains open.
