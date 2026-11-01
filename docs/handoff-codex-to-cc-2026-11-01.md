# Codex → CC handoff — 2026-11-01

Follow-up: [MVP API/CLI acceptance](acceptance-mvp-cli-2026-11-01.md) subsequently passed items 1–8. The record below preserves the earlier handoff and its original evidence boundaries.

Authoritative tracker: [#838](https://github.com/alexj11324/Mikka/issues/838). Consolidated **Draft** PR: [#847](https://github.com/alexj11324/Mikka/pull/847). This is a handoff, not a production-ready release. The final user instruction was to stop validation and further fixes, push all completed work, open one Draft PR, and return control to CC. No review request, merge, production deployment or public template publication was performed.

The implementation candidate is `4ca4a9376b7f3b8c50e5df2e8d43068773c092e8`; the final handoff commit adds this document and its [sanitized evidence/resource inventory](handoff-codex-to-cc-2026-11-01.json). See the PR head and #838's final comment for that commit. #840, #836, #842, #844 and #846 are continued by this PR; they were not merged by this session. #765/#760, AGENTS.md and browser-gate.yml were left alone.

## Completed work and evidence

- Local MVP items 1–5 and native mailbox item 6 passed on immutable artifact `b1be878572d5b9127dbf1b8506f550c61fc71c3a`.
- Worker mailbox item 7 passed on `9e19281e77ba8ec6cde1261d57d747c23d1bc0c7`: commands notification → real worker inbox/read/reply/ACK → worker succeeded, with automatic sender ACK and no human reprompt or inbox polling.
- The two runs have runtime fingerprint `11707ccd6876788c694b65d8733197ab0179f1d442fc38cd368aae2eead3061e`. Only the reviewed worker-mailbox test helper differed. The original partial manifest remains overall-failed for its original helper failure; it was not edited into a pass. A separate review verifies original hashes and step receipts.
- Item 1 used real DeepSeek and real push to a local bare repository, with a synthetic GitHub API/PR fixture. It does **not** establish a real production GitHub PR. GitHub App installation/permissions were independently read through an E2B egress path; local managed HTTP rewrites GitHub Authorization, so local `/app` 401 is not proof of an invalid App key.
- Read-only enforcement has a real CLI sandbox negative push and identical writable positive control, with unchanged/restored refs. A discovered local-fixture config/hooks host-execution path was fixed; its actual sandbox regression includes the original GPG marker positive control, denied writes, marker absence after the fix, and a successful normal push. This protects fixture host configuration without removing project work or normal push capability.
- Prior effective checks: root TypeScript/lint; daemon 679 passed/8 skipped plus CLI 22, repository 4 and credential 6 tests; protocol 249 passed; real PostgreSQL thread lifecycle 18/18 and issuer 3/3; hosted runtime 21/21; JS relay 4/4 and Python relay 8/8. The later security delta passed 12 targeted tests, the actual sandbox regression and the separate read-only sandbox test. Existing CI now invokes the new sandbox test. These are reused scope-specific results, not a claim that every suite was rerun on the documentation commit.
- The final user requested no further checks or CI wait. No browser tests were run.

## Cloud item 8 — failed, not complete

The last normal driver run began at 18:06 UTC with a borrowed owning-driver account lease. Versions were deliberately recorded separately: API server `9e19281e…`, driver `4ca4a937…`, template source `88cd4339…`, worker hash `b6762fc81a36b859f85acc749a00c6bf180d5a19`.

Normal sign-in and model-key installation succeeded. Coordinator POST returned 202 and the real user message was marked attention/delivered, but no assistant/tool/issue/run appeared within 120 seconds. `coordinator_sessions.lastError` was `Step doStreamStep` (`@ai-sdk/workflow` 2.0.80), `Service Unavailable`, with zero retries. Failure stage: `real-model-selection`. It never reached task creation, restricted relay/claim or a cloud worker first event. Do not report full E2B acceptance or end-to-end latency as passed.

One source sandbox was actually created; `finally` killed it and recorded `cleanupConfirmed=true`. Zero task sandboxes were created. Earlier failed fixture attempts used no paid sandbox. The fixed retroactive `recordResource` call and duplicate helper lease must not be reintroduced.

Retained diagnostics, when this workspace still exists:

- `/tmp/mikka-cloud8-normal-security.log` and `/tmp/mikka-cloud8-normal-security-versions.json`.
- `.cache/dev-local/cloud-7fd20c4f-36e9-49ac-8ad8-b41dcf572e47/result.json`.
- Fixed-copy original local manifests under `/workspace/mikka-acceptance-fixed/.cache/dev-local/acceptance-78af1e8fcab74b8a/` and `acceptance-8bf42802bdad4bc6/`; separate `reviewed-local-evidence.json` at that copy's cache root.

These temporary paths are supplemental; the committed JSON preserves the important non-secret outcomes and resource identifiers.

## Preview, production and retained resources

Latest Preview is [mikka-fsuzqeysk-mikka-dev.vercel.app](https://mikka-fsuzqeysk-mikka-dev.vercel.app), deployment `dpl_CJ2GJiaf298UtvyJErEsYZ1XKdHX`, implementation `4ca4a937…`. It was READY. Earlier immutable Previews are `mikka-cbwe1sn1v-mikka-dev.vercel.app` (bb2a) and `mikka-89q8537vm-mikka-dev.vercel.app` (88cd). Anonymous API/shell and authorization probes passed; the isolated database has 217 tables and the new mailbox migration/columns.

The dedicated empty-start Neon database is `mikka_handoff_20261101`, Mikka Staging project `raspy-cake-00359612`, branch `br-green-glade-b4fc98vb`. Preview's four DB bindings and `MIGRATE=1` are branch-scoped to `codex/handoff-complete`. Preview mail uses the existing `staging:/auth-email` key. Explicit cloud gates, matching private template/hash and worker branch URL are also only branch-scoped. The temporary worker alias capability was revoked; its invalid sensitive env binding can be removed before a later cloud run.

The normal Smoke account was created through signup 200 on the 88cd Preview, and its session 200 matched the identity. `emailVerified=false`. The session runner stopped before consuming a verification link, creating Smoke Bot, or running authenticated smoke. The same isolated DB is reused by the latest Preview. Complete verification with a fresh normal email link; do not edit auth rows or fake CI. Preview had no Turnstile keys configured; no Turnstile guard was removed.

Production remains `https://app.aspectlylabs.com/mikka`, deployment `dpl_5rfa69VkF41ET3yTkPu6YPpqWRbw`, commit `7228666f9bd7f23fc81bd205dd685611ae42744c`. Its existing normal-account read-only API smoke passed before handoff. This is not a deployment or active production cloud/Git acceptance.

The matching template `5ho2gh9c6zmfq8mq18vo`, build `920535cd-bd48-45bf-8d95-400fa49050ba`, is **private**, with worker hash `b6762fc81a36b859f85acc749a00c6bf180d5a19`; it was never made public. Metadata is `/tmp/mikka-e2b-final-security-result.json`. All earlier private templates and filesystem snapshots are listed in the committed JSON. Do not use the old xnc7/f3b020 template for this security-fixed worker. A later public release must follow the existing release pipeline or explicit subsequent instruction.

All new diagnostic/cloud-test VMs were reported killed. Local owning services/leases are being normally stopped and private session/daemon files cleaned; retained isolated DBs, bare repositories, redacted logs, Previews and private templates are intentionally not deleted. The original MVP_TEST acceptance Bot prefix `10ed0948` and paused machine `if7o8xrdmfzgbd1lmovdc` were untouched. Enumerate/delete retained test resources only within their verified non-production scope when no longer needed.

Secrets remain in the existing Mikka Infisical identity: `prod:/` SMOKE_OWNER_EMAIL/PASSWORD, `staging:/auth-email` RESEND_API_KEY, `dev:/vercel` DEEPSEEK_API_KEY, `prod:/vercel` E2B_API_KEY, `prod:/github` App credentials, `prod:/platform` VERCEL_TEAM_TOKEN. No secret value, cookie or verification link is included here.

## CC restart steps

1. Start from PR #847, read #838's latest authoritative comment, and diagnose Coordinator `doStreamStep` ServiceUnavailable using the retained log/session evidence. Do not silently turn the failed cloud result into a pass or add retries without understanding the failure.
2. Bootstrap a fresh normal isolated local environment/account lease when the old services or private files have been stopped/removed. Node 24 and pinned pnpm 10.34.3 are required. Keep all configured DB URLs on the same loopback `*_e2e` target. Never set CI/GITHUB_ACTIONS/RUNNER_ENVIRONMENT/GITHUB_RUN_ID to pass a guard.
3. Default local entry: `node --import ./tests/support/server-only.mjs --import tsx scripts/dev-local/acceptance.mjs` with `MIKKA_LOCAL_TEST_ACCOUNTS=1`, `MIKKA_DEV_SKIP_ENV_FILES=1`, and real sandbox tools on PATH. It owns database setup, normal account allocation, services and cleanup. Default items are 1–7. Reuse unchanged valid evidence; rerun the affected scope when product code changes.
4. Cloud entry requires a live owning descriptor, matching DB environment and valid prior local evidence, not a stopped descriptor. Use `LOCAL_LOOP_ITEMS=8`, `LOCAL_LOOP_LOCAL_EVIDENCE_FILE=<reviewed-local-evidence.json>`, `LOCAL_LOOP_CLOUD_TEMPLATE_FILE=<matching template metadata>`, `MIKKA_TEST_ENVIRONMENT_FILE=<live environment.json>`, `NODE_USE_ENV_PROXY=1`, then the same Node entry with `--existing`. The driver lends its normal accounts/pool; the helper must not acquire another pair. Bind three DB URLs, BETTER_AUTH_URL and MIKKA_TEST_DEPLOYMENT_SHA to that live descriptor. E2B credentials load in memory through the existing Infisical identity.
5. Preview identity can use the existing Smoke credentials, connected primary Gmail and exact immutable origin. Preserve the complete normal verification token/nonce/callback in memory. Create Smoke Bot through the ordinary API after verification. Use supported Vercel authentication/short-lived access for its protection; do not disable protection or fabricate local-pool attestation for a remote DB.
6. No merge or production release is authorized by this handoff alone. The user stopped this session at Draft PR + issue handoff. Resume further work only under CC's subsequent direction.
