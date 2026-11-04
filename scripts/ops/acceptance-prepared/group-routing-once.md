# One routing entry and its inactive workflow

This draft is prepared only. No source/deployment or successful core-artifact placeholders are filled, and no workflow has been installed or triggered. It adds no provider call to preparation. The policy rollback remains a separate scenario and does not run in this job.

## Evidence binding before credentials

`group-routing-once.mjs prepare` uses only the job's existing read-only GitHub token. It requires the exact repository, temporary branch, push event and first run attempt. It reads the pinned original core workflow run, requires that run's only job to be the pinned successful acceptance job, then reads the exact artifact. Repository, branch, workflow path/ID, core driver commit, run/job/artifact IDs, artifact name, expiration and available artifact digest must match. A failed core workflow, fork or extra job is rejected before download.

The GitHub archive endpoint supplies a short-lived302 redirect. The second GET is restricted to the expected HTTPS Actions storage hosts and carries no GitHub Authorization header; the signed URL is never retained or printed. The downloaded ZIP must match the reviewed ZIP SHA256 and contain exactly one regular UTF-8 results.json (no symlink, path traversal, encryption or extra entry), at most2MiB uncompressed. Those exact report bytes must match the separately pinned JSON SHA256. Whole-core/group pass,24 complete logical replays with accepted quality, and the matching production source/deployment are checked before any application credential is read.

GitHub metadata and artifact bytes jointly establish provenance here; a caller-supplied hash alone is not treated as origin proof. The saved private manifest records only safe IDs, digests, source/build and the current job's run/head context. The core report is stored only as an input and is not re-uploaded. No original log or raw archive is published.

## Unique invocation and temporary installation

After preparation succeeds, the workflow reads exactly the existing named Smoke email/password from prod:/ and the Flash key from dev:/vercel through the established Infisical OIDC identity. It reads no E2B or PostHog secret. `group-routing-once.mjs run` rechecks the source and driver checkouts, manifest/current-job binding and exact report bytes, then creates an exclusive execution marker before calling `runGroupRoutingBundle`. A second invocation in the same job fails even if the first attempt failed; it cannot retry prompts into passing evidence.

Only after an actual passing core artifact exists may the owner fill these literal pins: deployed source SHA and deployment ID; original core temporary driver SHA; core workflow/run/job/artifact IDs; archive SHA256 and exact results.json SHA256. The original artifact must have the single acceptance job and the standard proactive-acceptance-<runID> artifact name. This draft does not invent any values or substitute a previously failed run.

For an explicitly authorized activation, replace the existing `.github/workflows/proactive-acceptance.yml` on the existing `acceptance/proactive-1157-1163` temporary branch with this entire template, and copy only the reviewed `group-routing-once.mjs`, `group-routing-bundle.mjs` and `group-routing-boundaries.mjs` into scripts/ops. Do not install a second active workflow. The unchanged production-acceptance concurrency group serializes this scenario with other work using that temporary-account credential helper; cancellation remains false.

The workflow job allows20 minutes for checkout, dependency installation, read-only provenance and the bounded runtime. The application wrapper's total remains10 minutes, with535 seconds maximum inner routing and65 seconds for credential/session cleanup. The run step has a separate11-minute process backstop. Only one routing scenario, at most eight messages, runs; policy rollback gets its own reviewed operator window and budget. No model call occurs during package installation or GitHub artifact preparation.

The only upload path is group-routing-sanitized/results.json. It contains the safe routing result and provenance manifest; no credentials, signed download URLs, original report body, prompts, replies or private roles are copied into it. Normal product stop/cancel/end acknowledgments remain distinct from independent provider observations.

## Offline checks and references

Run `node --test group-routing-once.test.mjs` and `node --check group-routing-once.mjs`. The eight tests use injected HTTP plus real local ZIP encoding/decoding; they do not contact GitHub, the application or a model. They cover metadata scope, missing/failed core evidence, hash and archive boundaries, authorization-free storage redirect, preparation/run binding, single invocation, secret-safe output, placeholder rejection and the three-secret template.

The binding follows the official [Artifacts REST API](https://docs.github.com/en/rest/actions/artifacts), [Workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs) and [Workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs). These reads require only Actions read permission. No GitHub mutation, workflow rerun or dispatch API is used by this entry.

The entry now uses the same pure `coreComparisonReady` validator as the normal-session wrapper, before fetching any application secret. It requires the explicit v2 comparison contract and preserves the actual completed count: a fully receipted baseline abstention is not rewritten into a completed judgment. Twelve complete candidate cases remain mandatory. Unversioned or failed historical core artifacts, including 41778455749, cannot authorize the addon. The workflow still contains only placeholders; these must come from a future actual passing core artifact and its observed source/deployment.

Current inactive-entry verification: 9/9 offline artifact, ZIP, provenance and v2 compatibility contracts, zero skips (`cmd_653485b0e04c489698d0286eedb0`). The original fixed-source/one-job/one-artifact/no-token-forwarding and exclusive execution-marker controls are unchanged. No actual workflow was activated or model invoked.
