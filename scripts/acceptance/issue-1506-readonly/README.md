# Issues 1504 / 1506: isolated read-only observation

These files are a local draft for root review and a dedicated branch push. They have not been run against production by this agent.

## Entry points

- `node scripts/acceptance/issue-1506-readonly/accounts-readonly.mjs observe`
- `node scripts/acceptance/issue-1506-readonly/coordinator-traces.mjs`
- Offline guards: `node --test scripts/acceptance/issue-1506-readonly/readonly.test.mjs`

The new workflow watches only its own path and `scripts/acceptance/issue-1506-readonly/**` on `acceptance/issues-1504-1506`. Committing only these new paths does not match the existing production baseline or Docker workflow filters. It uses the existing `production-smoke-owner-acceptance` concurrency group, so account observation does not overlap the baseline acceptance session.

## Identity and scope

`alex-session.mjs` exports `alexSession(work, options)` and `ALEX_OWNER_ID`. The callback receives the same `request`, `json`, `rpc`, `requests`, `identity`, and `version` shape as the old `productionSession` helper. It follows that helper's normal sign-in, get-session, version, cookie, RPC and sign-out protocol. Only `ACME_DEMO_EMAIL` / `ACME_DEMO_PASSWORD` are read. The authenticated email and exact Alex owner ID must both match. Cookies are local to the one session, and final sign-out has a separate 15 second budget. An exact expected SHA is supported for later acceptance drivers; the read-only caller passes `null` and captures a valid, stable observed build.

Smoke uses the original helper and its original credential names in a completely separate session. Both accounts must select the exact dedicated workspace `d32ed7ad-4253-47dd-a94a-66b24dd07d35` / ref `e917cd887945`, with the known name/slug and exactly the expected active Smoke admin and Alex member. Member names, emails and invitation data never enter the report.

Smoke discovers the existing bot whose ref is `87b186df9c42` from the own-workspace `/api/bots` result. It makes exactly one `coordinator.syncCoordinatorChat` call with that UUID. It reports `working`, active stream presence, whether the old workflow is still active, and idle status. It sends no stop or message, even if the old chat is still active. It does not report historical text or attempt to prove the earlier stopping latency from this later observation.

Alex reads the normal model order, own subscription share, member sharing policy and own credit-share metadata. A model menu is read only for an already existing own-workspace bot. If none exists, the report explicitly says `not_observed_no_existing_bot`; it does not call a null menu or initialize a Coordinator. Subscription option UUIDs are noncredential identifiers retained for a subsequent normal model selection. Source connections are represented by hashes and by whether they match the two preverified Alex connections. This preflight cannot prove frozen `binding.access = owner`; the actual run evidence must do that.

The billing action is intentionally not called: Alex is a member, while the action is admin-only and runs legacy-verification initialization. Credit-share state is read directly; when an existing bot menu is available, its hosted group supplies displayed workspace points/trial metadata. No credit/subscription policy is changed. Normal read actions can internally ensure a missing subscription catalogue, as the product already does; no explicit catalogue refresh, quota probe or model request is sent.

## Trace query

The original `issue-1504-1506/coordinator-traces.mjs` two bounded metadata queries are preserved in a new file, with a third exact-trace query. All three use `mikka-web`, production and the fixed interval `2026-11-06T19:12:15Z` through exclusive `19:12:45Z`. The exact query filters trace `96e5da44b7e53a0e09a9cc512f3b3522`; no workflow-run attribute is assumed. `wrun_41M6S4DDPT0GXRWK0JQRX06QSW` is marked as a supplied correlate from the baseline receipt, not a PostHog join. There is one request per query, each bounded to 60 seconds; no retries, offset expansion, asynchronous query polling or wider date range.

Only route/name/timing/status/span identifiers are selected and retained. Missing spans remain ambiguous under sampling/export/filtering. No cache hit or miss is inferred from an empty query. Credentials are read individually through the existing Infisical OIDC identity: the four login keys at `prod:/`, and `POSTHOG_PERSONAL_API_KEY` at `prod:/platform`. No keys are printed or uploaded. Each final report is sanitized JSON in `issue-1506-readonly-report`.

## Offline verification

Nine fixture tests passed with the default network disabled. They cover separate identities, one old-chat read, no implicit Bot creation, an existing Codex option, honest active-chat observation, member/owner guards, closed server errors, normal ACME login and sign-out, wrong-owner rejection, fixed trace scope, and three bounded requests without retry. These are driver guards; they are not production results.
