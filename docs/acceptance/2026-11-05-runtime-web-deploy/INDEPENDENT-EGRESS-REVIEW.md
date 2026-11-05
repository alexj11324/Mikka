# Independent review: official runtime → GitHub Web deployment

Reviewer: `/root/egress_1211`  
Review date: 2026-11-05 UTC  
Scope: static source review and inspection of the author's existing raw test evidence. No new test execution, production request, workflow trigger, model call, deployment, credential access or source edit was performed by this reviewer.

## Conclusion

No remaining source blocker was found in the final seven-file candidate reported as tree `d6051ef87b6b18c1cc894942468e6bd23046e8eb`, based on `efef5b5a5a8a55deb3c504b05fb736d4003e942c`. The seven complete source files were independently copied and their byte counts, SHA-256 values and Git blob IDs were recalculated and matched against both the final manifest and the filemap.

This conclusion permits ordinary PR/CI review of this deployment repair. It does not establish that the reusable workflow's live OIDC exchange, official-instance validation or the production deployment has succeeded. Those remain actual release gates. It also does not satisfy the tracking issues' performance-hour or three-model-path acceptance requirements.

The initial candidate `4f91be86ac293bf04b2fc147ffe24b0e2eae03da` had one concrete caller-queue liveness defect. The final candidate corrects it; the finding and its resolution are retained below.

## Exact files reviewed

| File | Final Git blob | Review |
| --- | --- | --- |
| `.github/workflows/web-deploy.yml` | `e97226987c6b9d88ad70340d2f5490b74dab6279` | Complete file; reusable inputs, queue, credentials, environment publication, build, upload and public-version verification |
| `.github/workflows/e2b-official-runtime.yml` | `d623fe2d05727935bce2eac6468b260c0ff881ac` | Complete original candidate plus final increment; caller queue, source guard, validation and reusable handoff |
| `scripts/release/web-deploy.mjs` | `62a70d9315cb85097f524cb1ca5a9fd438002ea9` | Complete source; bounded wait, exact source/run checks, release-control predicate and public version |
| `scripts/release/web-deploy.test.mjs` | `b9cb09aba0f8b5d36c2d091306e4912b1c12db97` | Complete tests, including real Git/production CLI multi-commit push comparison |
| `scripts/e2b/publish-template-env.mjs` | `d04390cffb9c1e14ef452dc9c516dd39d6061f7c` | Complete source; one environment mutation, readback, source checks and no deployment request |
| `scripts/e2b/publish-template-env.test.mjs` | `aa17e3a56b3875a83e64428c27159428e25546da` | Complete tests; old production gap, no-op recovery and uncertain mutation |
| `docs/operations/web-deploy.md` | `80ada4817517fdd279bde34cf3ba4c39f5d47d85` | Complete documentation and final increment; recovery and non-atomicity boundaries |

The independent file-hash receipt is `finald605/independent-file-hashes.json`. The candidate root tree is the author's actual Git write-tree result; this review independently verifies the seven changed blobs and their stated base, not a second full repository checkout.

## Finding resolved during review: caller pending request loss

The initial E2B caller used its existing production concurrency group with the default single pending slot. The shared Web job's new `queue: max` did not protect a runtime workflow before that workflow reached the reusable Web job.

A reachable scheduler sequence was:

1. An E2B release R occupies the caller's production group.
2. A newer main release B waits in that group.
3. A delayed older release or rerun A enters the same group.
4. GitHub's default pending replacement cancels B and leaves A pending.
5. A later fails the current-main source fence. That rejection does not restore B.

This was a source/scheduler counterexample, not a claim that the sequence was observed in production. GitHub's documented concurrency contract confirms the default replacement behavior and that `queue: max` cannot be combined with `cancel-in-progress: true`:
https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

The final caller uses a static `queue: max` and `cancel-in-progress: false`. PRs retain their own separate group and the main/non-PR check guard still excludes them from credentials and paid validation. The intentional tradeoff is that an obsolete short PR offline test may finish or remain queued instead of being cancelled. No unverified queue-expression syntax is required.

The new check-job current-main guard runs before its first Infisical access. An obsolete queued production workflow is therefore rejected before it starts the normal credential/validation path. A branch may still advance after a successful check; the later wait, publication and upload guards remain necessary.

## Safety and correctness boundaries inspected

### Prebuilt publication only

The publisher no longer creates a Vercel deployment or requests a source build. Its only write is the fixed project/team production environment upsert. After exact readback, the reusable Web job performs the existing GitHub `vercel build --prod` and `vercel deploy --prebuilt --prod --archive=tgz` sequence.

The same job-level `web-deploy-production` queue spans environment publication, build, upload and public-version verification. There is no second acquisition of that group at the Web workflow level. The E2B caller's distinct group is not a competing acquisition of the Web group.

### Web wait and immutable source checks

The wait is a read-only E2B job outside the Web deployment queue, with GitHub contents/actions read permissions and no Infisical step. It cannot occupy the queue required by the Web job it is waiting for.

Admission requires the exact repository, head repository, main branch, source SHA, Web workflow path and permitted standalone event. It selects the latest matching run and verifies the actual run attempt's completed-success deploy job and each named build/upload/public-verification step. Skipped steps, an incomplete jobs listing, a failed latest attempt and a previous success do not substitute for a completed build.

The wait uses a monotonic 40-minute budget, request timeouts, an exact public build comparison and a final current-main check. A response arriving after the budget does not pass. The root coordinator separately reported checking these fields and step names against a real GitHub run/attempt response; this reviewer did not repeat that production/API read.

The shared Web job checks current main before release work and immediately before upload. The publisher also checks it before production-source inspection and again after environment reads at the mutation boundary.

### Configuration mutation and recovery

The publisher uses the existing fixed project/team and canonical production source. It requires the full source commit, official template names, measured harness model metadata and worker hash. It reads the six exact unbranched production configuration keys, performs at most one upsert if needed and requires exact readback.

An unknown POST result is a failure, not an automatic retry. An explicit failed-job rerun reads current values again; even if the prior upsert succeeded, the runtime-refresh path still requires the Web build instead of treating matching environment values as completed deployment.

GitHub and Vercel credentials are sent only to their respective fixed API origins. Public-version requests carry no authorization header. The new errors report status/codes and source SHAs rather than response bodies or credential values. The existing identity, audience, project and secret paths remain unchanged; no trust or permission expansion is part of this candidate.

### Release-control push trigger

The final four-path list is fixed to the two release workflows and the two production release scripts. It compares the actual `github.event.before` and exact `github.sha` with complete Git history. It does not compare only the last commit. Invalid/all-zero before values, mismatched after/ref, unavailable history and malformed diff results reject instead of being interpreted as unchanged.

A release-control change bypasses only the unchanged-worker-hash optimization. The same full official-instance validation still produces the worker/model outputs required by the reusable Web call. Worker hashing and measured model selection are unchanged. Documentation and test-only changes do not force validation through this predicate.

Manual `runtime-refresh` remains default false. It does not make PR events eligible or create a path around validation.

## Existing evidence inspected

The final raw logs under `cloud-proof-v3/logs/` were read, including the individual new test names and the totals:

| Evidence | Actual result inspected |
| --- | --- |
| `mikka-runtime-release-red.log` | Initial old-product set: 16 tests, 13 passed, 3 failed |
| `mikka-runtime-release-timeline-red.log` | Old orchestration on the publication timeline: 1 test failed with `production_source_changed` |
| `mikka-runtime-release-green-v3.log` | Final narrow suite: 43 passed, 0 failed, 0 skipped |
| `mikka-runtime-release-related-v3.log` | Final related suite: 81 passed, 0 failed, 0 skipped |
| `mikka-runtime-release-lint-v3.log` | 0 warnings, 0 errors on the four JavaScript files |

The 81-test related suite includes the narrower tests; these totals must not be added as independent coverage. Earlier 39/40-test iterations and the initial missing-`pg` related-suite failure remain preserved rather than being represented as final results. The real Git/CLI test covers a control change earlier in a multi-commit push, a later docs-only push and unavailable before-history. The workflow tests inspect the actual YAML wiring; they do not emulate GitHub's scheduler or prove a live OIDC exchange.

## Remaining operational limits

- Queue ordering plus source checks do not create an atomic transaction between GitHub's main ref and Vercel environment/configuration. A push can occur after a guard; the final upload guard and serialized latest release limit the effect. No stronger atomicity claim is warranted.
- If main advances from runtime source A to a docs-only B while A validates, A is intentionally rejected. B may have no E2B run and its Web build may be skipped while production remains at A. A manual runtime refresh on B cannot manufacture a successful actual B Web build. Recovery then requires a subsequent normal application/release-control change, or a separately reviewed future recovery mechanism. This candidate does not implement automatic catch-up for that case.
- Failed-job rerun is valid only while its source is still current main. A full rerun with default inputs may skip an already matching worker hash; the documented explicit refresh is distinct.
- GitHub queue behavior, same-repository reusable OIDC claims, actual instance validation, prebuilt upload and the public build pin require real release evidence after normal merge. Local source tests are not those proofs.
- No production acceptance, fixed-hour comparison, model-path acceptance, egress improvement or closure of a tracking issue is asserted by this review.

