# PR 1217: main 40d integration and local verification

The public PR head is **`f45e0f268dac28e0a94213a977d6b4ce4aaa31bf`**, a normal merge with ordered parents `cccef174f7a4e604a820a4b61f8521e8cdba100b` and `40d03479ea8260b8934f609b84c7c9cb60a94b3c`. The complete tree is **`de3b83d85361e39a33ca9e5678d4ed37e6a33fe4`**. GitHub's created tree and an actual Git fetch/readback match the local tested tree; the original branch moved using CAS with expected ccce, and `ls-remote` confirmed f45.

PR 1217 is **open/ready (`draft=false`) and held unmerged**. At 2026-11-05 02:13:11 UTC, [the exact new CI run](https://github.com/alexj11324/Mikka/actions/runs/41953008428) and all seven associated workflows had completed successfully. The exact head has 27 completed checks: 22 success and five conditional skips. `ci-final-proof.json` preserves the full check response and workflow results. The older head's green CI is not counted for this head. The paid local-loop cloud leg remains unmet, and nothing in this evidence waives it or the three production model paths.

The final PR API read at 02:14:07 UTC reports `mergeable=false`, `mergeable_state=dirty` and `auto_merge=null`. The parent reviewer then independently found that main had advanced externally to `514030294dcdc68b2d9ca4a977ce04b298b37e6f` through #1297 (parent `0118fe5358a4593d1dfd2aa9127ce6682ea46089`), while the PR base snapshot still showed 40d. This packet is explicitly limited to **integration against 40d**, not the later Agent Profiles/Claude-Codex collaboration changes. It does not claim the PR is immediately mergeable, and no further main integration or merge was attempted.

## What was integrated

Five content conflicts were resolved narrowly: four import intersections and one diagnostic fixture. Main's original-question worker update from #1301 and committed list notifications remain intact. The fresh task runtime still admits a sleeping/uncreated parent without waking it; original-session question continuation still uses its own VM and native session, immutable Owner answer/recovery receipt and current task/epoch/candidate/lease/stop checks.

The candidate remains exactly the original PR's **27 paths: 26 content files and one deletion**, `lib/factory/cloud-stage-admission.ts`. Eighteen content blobs match the old PR exactly; eight incorporate the expected main intersections. Main's seven #1302 release-control blobs and `thread-worker-logs.ts` are byte-for-byte preserved. No unrelated product functionality was added.

- [Complete public source](https://github.com/alexj11324/Mikka/tree/f45e0f268dac28e0a94213a977d6b4ce4aaa31bf).
- [Full old-head comparison](https://github.com/alexj11324/Mikka/compare/cccef174f7a4e604a820a4b61f8521e8cdba100b...f45e0f268dac28e0a94213a977d6b4ce4aaa31bf).
- `candidate/vs-main.patch` and `candidate/manifest.json`: complete main-relative patch and all 27 paths with content hashes.
- `BOUNDARIES.md`: version-bound conflict review, written before publishing the ref.
- `INDEPENDENT-EGRESS-REVIEW.md`: independent source, exact-tree and raw-gate review.
- `root-github-tree-proof.json`: parent reviewer's full remote tree comparison, showing exactly the 27 intended changes and 4,556 unchanged original leaves.

The independent review reconstructs the tree from the two public Git objects and the content map. Its summarized verification and eight-file old-head delta are included under `independent/`; the large raw GitHub tree listings are reproducible from the named public commits and were inspected in the shared workspace rather than duplicated here.

## Actual local checks

All checks ran in the existing cloud Linux environment. PostgreSQL tests used a new random-password role and unique loopback `_e2e` database; providers and external lifecycle launches were fixtures, not real cloud/model execution.

| Gate | Adopted result on this exact tree |
| --- | --- |
| Cloud limits | 29/29, 0 skip |
| Retained deliverable probe/glob | 11/11, 0 skip |
| Task runtime / original question VM / stop / first-use / fallback / run end PostgreSQL | 119/119, 0 skip |
| Factory checks / continuity / inherited command / question execution PostgreSQL | 138/138, 0 skip |
| Next typegen / Workflow graph | exit 0 |
| Repository typecheck | exit 0 |
| Oxlint | exit 0 |
| Diff check against actual main 40d | exit 0 |

`LOCAL-VALIDATION.md` explains the environment and precise limits. `gate-proof/` includes both complete runners, all raw logs, command/PID/time/exit receipts, and their exact runner-only difference. The local merge commit `9441896ad27e0f072d11dc24194351623327a2ac` has the same tree and ordered parents as public f45; only commit metadata differs.

## Failures retained, without changing the product to pass

The first install used the image's pnpm 11 and failed; the repository-specified Corepack pnpm 10.34.3 installation succeeded. The first PG runner mistakenly included `/mikka` in an origin-only configuration, causing `Invalid authentication email origin` during imports (63/73 task tests and 62/65 Factory tests). Only the external runner origin was corrected, using a new role/database; the product, auth guard, test assertions and CI/local-mode flags were unchanged. The two affected groups then passed in full. These are preserved environment failures, not manufactured product RED-to-GREEN claims.

The original and corrected runs both cleaned up with the **existing local admin**, enumerating only databases owned by the new temporary role, requiring `_e2e` names, then using scoped **`DROP DATABASE ... WITH (FORCE)`** and dropping that role. Both receipts confirm own databases and role absent. This is not a claim of ordinary non-forced DROP or a pre-observed zero-connection state; no existing role permissions, production database settings, unrelated local database or shared token were changed.

## Remaining gates

The exact public head's CI is complete. Before a future merge, the later main changes must be reviewed and normally integrated with their own appropriate verification. The original paid cloud-leg and real production acceptance remain separate unmet requirements. No model prompt, production operation or shared credential change was made for this integration, and the PR was not merged.
