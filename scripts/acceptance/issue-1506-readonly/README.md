# Issues 1504 / 1506: verified ACME account, personal scope, read-only

This revision corrects the account mapping discovered by the first production login. The ACME account is `OFtPbAHifGBAOYiek9hd3w`; the previously assumed `XjT...` account is a different subscription owner. The normal login must match the ACME email and this exact owner ID. No fallback to the other identity or its workspace is allowed.

## Entry points

- `node scripts/acceptance/issue-1506-readonly/accounts-readonly.mjs observe`
- `node scripts/acceptance/issue-1506-readonly/coordinator-traces.mjs`
- Offline guards: `node --test scripts/acceptance/issue-1506-readonly/readonly.test.mjs`

The account script runs only one Alex ACME session. It no longer reads Smoke credentials or the old isolated team. The workflow reads only `ACME_DEMO_EMAIL`, `ACME_DEMO_PASSWORD` at `prod:/`, plus the trace key at `prod:/platform`. Smoke's final idle observation was already obtained by the prior run and is not repeated.

## Verified scope and sources

The session discovers the signed-in account's workspace choices, requires exactly one personal workspace and the verified UUID `4ae2a643-b09e-43eb-816c-1e5557bef170`, switches through the normal product action, then verifies the personal workspace has only this active admin. Existing team choices are counted but never entered or changed. Names, emails, slug text and member display data are not retained.

Model-order candidates/entries retain only model/provider/harness/block enums and connection hashes. `authorizedAlexSource` now refers only to the two independently verified connected ACME-owned sources: Claude hash `ccca34377eae9409a9c3e3c6bca856ba0f9ea23d5fe79e148a560f37c928615c` and Codex hash `f05380d0f88c99a624bd7a78b0357c6d4841ddff43438c0bdcf7705d62f5374e`. No assumption from the former shared owner is used. This inventory cannot prove a future frozen run's resource binding; actual runtime evidence remains required.

The script reads subscription/share-policy/credit-share metadata and one model menu only if an existing own-personal-workspace bot is present. It never calls a null menu, chat sync, message send, stop, model selection, quota refresh, catalogue refresh, workspace creation or credit/subscription mutation. The personal subscription-share DTO intentionally omits its `own` provider list; `ownProvidersFromVerifiedOrderSources` is therefore reported separately from the raw DTO's empty list. Existing Bot subscription option UUIDs may be retained for a later normal model choice; credential labels, names, plans and credentials are dropped. Billing is not read, because it can initialize legacy verification; displayed points/trial metadata comes from an existing Bot's hosted menu group when present.

`alex-session.mjs` exports `alexSession(work, options)` with the same callback shape as `productionSession`: request/json/rpc/requests/identity/version. It consumes only the ACME credential names, keeps cookies within one session, and reserves 15 seconds for final sign-out. Later execution drivers can require an exact SHA. This observation captures a valid build and checks it stays unchanged.

## Fixed trace window and token diagnosis

The existing two metadata queries plus one exact-trace query use only `mikka-web`, production and `2026-11-06T19:12:15Z` through exclusive `19:12:45Z`. Target trace: `96e5da44b7e53a0e09a9cc512f3b3522`. `wrun_41M6S4DDPT0GXRWK0JQRX06QSW` is supplied baseline correlation metadata, not a claimed PostHog join. Each query gets one request bounded to 60 seconds; no retry, wider window or query polling. Empty sampled results do not establish cache hit/miss or zero latency.

Official PostHog documentation specifies a Bearer personal API key, without the earlier script's restrictive character alphabet: https://posthog.com/docs/api/personal-api-keys and https://posthog.com/docs/api . The driver now accepts a nonempty trimmed header-safe key, rejecting public `phc_`/`phc-` tokens, embedded newline/NUL and an unreasonable header length. It reports only `{exists, startsPhx, hasWhitespace, length}`; no prefix value, token or token hash. This distinguishes an absent Infisical export from a shape mismatch before any request. The fixed private API host remains `https://us.posthog.com`.

## Workflow and evidence limits

Only the workflow's own path and `scripts/acceptance/issue-1506-readonly/**` match its branch push filter. They do not match the existing baseline or Docker workflow. The normal acceptance concurrency group remains in use. Reports are sanitized JSON under `issue-1506-readonly-report`. `accounts[0]` is the sole ACME account observation in this revision.

Ten offline fixture tests pass with default networking disabled. They cover the corrected exact owner, strict personal scope, no team fallback, no Smoke/chat calls, no implicit Bot creation, ownership guards, normal ACME login and sign-out, rejected prior-owner identity, closed errors, fixed trace queries and safe key-shape diagnostics. These are client guard tests, not production evidence. No production call was made by the drafting agent.
