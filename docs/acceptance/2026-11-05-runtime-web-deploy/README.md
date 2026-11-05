# Runtime publication repair — PR #1302

Published source: `c9da99ff14d7fd3446e0417d3a54fc0408442dff`, based on `5d2011f0f27a4ae300909dd1632ffede8a763471`, tree `58f14e63fc36cf12a936b9825604f71162586a84`. The seven release blobs exactly match the cloud-tested candidate below; all 4,573 unrelated main blobs are preserved (root independent GitHub tree proof).

CI: https://github.com/alexj11324/Mikka/actions/runs/41949914315 . At evidence assembly the exact-head CI is in progress; the E2B PR offline test succeeded and production jobs were skipped. The live reusable OIDC, instance validation and prebuilt publication remain post-merge gates. No production write or model prompt was used to make this evidence.

# Runtime publication through GitHub Web deploy

## Candidate and observed failure

- Base: `efef5b5a5a8a55deb3c504b05fb736d4003e942c`.
- Exact candidate tree: `d6051ef87b6b18c1cc894942468e6bd23046e8eb`.
- Seven changed files; no worker hash recipe, model catalogue rules, cloud acceptance guard, application, database, identity or trust-policy change.
- Source map, complete Git diff and per-file hashes: `cloud-proof-v3/filemap.json`, `cloud-proof-v3/change.patch`, `cloud-proof-v3/manifest.json`.
- Cloud Linux: existing Vercel sandbox `sbx_5x2oLaIP0UGMlfzq0MmpJv1OOMGu`, independent `/vercel/sandbox/mikka-runtime-web-release`, Node v24.22.1, frozen pnpm 10.34.3 install.

Root independently established two production failures:

1. E2B run `41943748222`, publish job `126972061558`: at 2026-11-05 00:49:31 UTC it rejected `3adee90c742b045e0eebd5854eecc6ade1c84aae` as `production_source_changed`. The matching GitHub Web build ran 00:46:25–00:49:35; Vercel could not see its upload until 00:49:35–00:50:29.
2. E2B run `41944628574`, publish job `126975166613`: at `2026-11-05T00:57:34.0065797Z` the old script explicitly logged `redeploy: dpl_FKBXLqPyXYbFNX1Pcu8yfzJwb1xV from dpl_7Qqfnj8E1dg4eeD2MeyCDHAjHtJ9`, confirming a Vercel source rebuild despite the required GitHub build pipeline.

Risk triage: occurrence 8/10 × impact 6/10 = 48. These are observed publication failures and an observed wrong build path, not a speculative optimization.

## Change

The E2B workflow retains its official-instance validation and measured capability outputs. A new read-only job waits outside the publication queue for the current source's latest successful Web run, its real build/upload/version steps, and the exact public `build`. It is bounded to 40 minutes and rejects a new main commit early. A docs-only skipped job does not satisfy it.

The publisher becomes an environment-only operation under the reusable Web deploy job. It checks current main and serving alias/public source, reads the exact production values, checks main again at the mutation boundary, performs at most one upsert, and verifies every value by readback. It cannot POST a Vercel deployment. Environment values already matching still require a GitHub build, which permits a failed-job rerun after an earlier env write.

Web deploy holds one job-level `web-deploy-production` group across env update, GitHub build, prebuilt upload and public verification. `queue: max` with `cancel-in-progress: false` prevents a late old runtime job from replacing a queued newer main job; it does not order jobs by commit time. Current-main checks before release work and immediately before upload remain necessary. No caller-level duplicate lock can deadlock the reusable job.

The existing manual E2B dispatch gains `runtime-refresh: boolean` (default false). True bypasses only the unchanged worker-hash optimization, then runs the original validation and every publication guard. The manual option supports normal operator recovery. This PR is exercised automatically by its actual main push changing the fixed publication-control paths; `worker_hash` remains unchanged. No model prompt is sent by any local gate.

## Actual verification

- Original publisher plus three new regression assertions: 16 tests, 13 pass / 3 fail / 0 skip. Failures demonstrate the forbidden deployment POST, missing rebuild after matching env, and stale-main write.
- Identical timeline fixture on the original efef product/YAML checkout: 1 fail / 0 skip, actual `production_source_changed`. This reproduces GitHub still building while Vercel has only the preceding READY source. The original files were not mocked away.
- Final candidate: 43/43 tests, 0 skip. Includes the same timeline fixture, official pair/readback guards, unchanged-env recovery, unknown POST not retried, main moving during reads, exact workflow/repository/attempt matching, failed/cancelled/skipped build rejection, bounded wait, no credential on public GET, reusable queue configuration and actual Bash dispatch comparison.
- Related release-security, operations and docs/ignored-build entry points: 81/81, 0 skip after the normal frozen install.
- Four changed JavaScript files: oxlint 0 warnings / 0 errors. `git diff --check`: 0.
- The first broad entry-point attempt failed because this new independent checkout had not installed `pg`; its raw log is retained. It is not counted as a product pass. The subsequent frozen install and exact re-run succeeded.

Raw logs are in `cloud-proof-v3/logs`. The cloud archive was downloaded with ordered chunks and verified against SHA-256 `6b46ad3258894cb721a30dff35c05459fd0738de622a4fbb79b9ebc90bcd11a5`; all seven local source hashes match the cloud manifest. The three-regression pre-fix test source is retained as `red-publisher.test.mjs`.

## Remaining real-world gates

No production env write, deployment, paid instance validation, model call or OAuth operation was performed for this candidate. No database or test account was allocated.

GitHub's queue semantics were verified against its official concurrency documentation; local tests check the committed configuration and source fences, not the Actions scheduler itself. A real PR/CI run must validate the workflow, followed by the merged release.

The repository's `docs/infisical-cloud.md` records repo/owner IDs, immutable subject prefix and branch-ref trust, without a documented job_workflow_ref restriction. The standalone Web and E2B jobs use the same existing identity, audience and project. That is not proof that the live identity accepts the new reusable-job claims. The caller and called job both declare id-token:write; only the lock-free waiter declares actions:read. Actual OIDC acceptance is a post-merge job gate; this patch neither changes trust nor creates an identity.

The connector has no workflow_dispatch capability and no new credential is requested. This normal main push will change publication-control files and therefore perform the complete validation and reusable publication. Root will observe OIDC → unchanged official validation → reusable Web build/prebuilt upload → exact public version. The existing manual refresh remains available to normal GitHub operators. A source change must stop a stale release; unknown mutations are not automatically retried.

The queue and fences do not make Git refs and Vercel environment an atomic transaction. A new push during build stops the obsolete upload at the final fence; the queued new main release continues. Recovery uses a forward or revert PR, not deployment deletion, token revocation, production database changes or Vercel source builds.

Official references:

- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations

## Final v3 increment

`increment-v3.patch` compares the earlier 4f91 candidate to final d605. The E2B caller now also retains its pending queue with static `queue: max` and `cancel-in-progress: false`; only short offline PR runs incur additional retention. Before release credentials, its check rejects stale main. `runtimeRefreshRequired` compares the complete actual push across four fixed release-control files, all also listed in the push filter. Actual Git + CLI tests prove an earlier control change in a multi-commit push triggers validation, a docs-only push does not, and unavailable/invalid before SHAs fail. The worker hash recipe remains unchanged.
