# Issue #172 foundation: Linux validation record

This is the historical phase-one/two record. Current source wiring and final
phase-three checks are in [BYOS integration](byos-integration.md); its status
supersedes the deferred-wiring statements below.

2026-10-24, Agent-owned cloud Linux, branch
`codex/issue-172-byos-foundation`. No user Mac or v0 preview was used.
This is a tested foundation, not activated dual-provider BYOS.

## Implemented and verified

- Pinned CPA `8289ec4c71ad914d0612c2776352b76ba3d355a6` SDK Store and
  login/refresh managers, with actual Claude/Codex Storage types and actual
  Codex partition-patch logic. The authenticators/executors in acceptance are
  injected HTTP fixtures, not live CPA provider adapters.
- Complete initial bundle normalization, scoped hydration, repeated task and
  worker-restart reuse, automatic access refresh, single refresh authority,
  reconnect/disconnect fencing, lost-write recovery and database-publication
  fault recovery. Provider bundles are stored only by the Infisical adapter;
  Postgres contains metadata/references/digests, not token values.
- Infisical v4 HTTPS create/versioned-read contract against a TLS fixture;
  immutable operation names plus Postgres publication checks, no invented
  Infisical CAS. Redirects and scope/integrity failures refuse use.
- Codex native broker interface: experimental host-managed login/refresh RPC,
  account binding, access-only handoff, no native auth-file link, sanitized
  failures, refusal of API-key modes/environments and SIWC/native confusion.
- Claude native broker interface: access-only OAuth environment input, separate
  runtime home, first-party/no-API-key mode check before prompts, account/expiry
  refusal and sanitized errors. No refresh grant or native credential-file
  conversion. The child ends at access expiry because this SDK has no documented
  host refresh callback; the next start reuses the CPA connection/authority.
- Explicit subscription model selection fails closed before paid-key lookup;
  route/ownership/binding/quota policy and clean native-child environments.

## Checks

| Check | Result / evidence in this workspace |
| --- | --- |
| `pnpm test:byos-worker` | Passed: 17 top-level Go tests plus 6 provider subtests, `-race`, `go vet`, private executable build/version/process acceptance. Real disposable Postgres 17 applied all 28 migrations and a second migration pass. Log `/tmp/mikka-cpa-acceptance-final.log` |
| Daemon suite | 201 passed, 7 real-agent tests skipped; `/tmp/mikka-cpa-daemon-final.log` |
| Native broker focused tests | 15 passed (8 Codex, 7 Claude), after final source cleanup; `/tmp/mikka-cpa-native-final.log` |
| Protocol suite | 223 passed; `/tmp/mikka-cpa-protocol-final.log` |
| Own-harness model tests | 8 passed; `/tmp/mikka-cpa-model-final.log` |
| Root and daemon type checks | Passed; `/tmp/mikka-cpa-root-typecheck-final.log`, `/tmp/mikka-cpa-daemon-typecheck.log` |
| Root lint, migration policy/tests, UI policy | Passed; `/tmp/mikka-cpa-lint-final.log` |
| Root `pnpm check` | Fails at pre-existing source assertions `tests/agent-ui.test.mjs:39` and `:433`; same failures reproduced on unchanged base. Later stages are not implied to pass. Latest log `/tmp/mikka-cpa-check-final.log` |
| Separate acceptance baseline | Existing partition-cookie assertion in `tests/acceptance.test.mjs` also fails on unchanged base; `/tmp/mikka-172-agent-baseline.log`. Not changed by this patch |
| Next production webpack build | Passed during phase one on Docker Linux (24 static pages); `/tmp/mikka-172-linux-build-final.log`. Phase two adds worker/daemon/migration code and does not change the web implementation |
| Browser | Phase-one Playwright/Chromium anonymous smoke: sign-in HTTP 200, no page errors, anonymous subscription POST 401/private-no-store and cross-site POST 403. `/tmp/mikka-172-browser-result.json`, screenshot `/tmp/mikka-172-sign-in.png`. No authenticated or live subscription browser acceptance |

All test Postgres containers were removed. Upstream source/module/build caches
are ignored; licenses and Go dependency sums are tracked.

## Deferred activation and next work

Neither live CPA authenticator nor provider executor is registered in the shipped
worker. Its acquisition/refresh/execute methods therefore refuse live use.
Both native brokers are opt-in constructor seams; production private broker
transport/launcher registration is not implemented. The public connection and
model APIs remain gated. This is not a working live sign-in or model integration.

Next source work is a reviewed CPA provider adapter with fixed upstream routes,
safe OAuth ceremony, model streaming/quota integration and authenticated consumer
binding. Inventory and exclude identity cloaking/fingerprint behavior before
registering any live executor. Configure a dedicated Infisical workload path and
permissions only under separate authorization; historical secret GC, provider
revocation and workload-token renewal/delivery still need integration.

Real Codex audience/version and Claude grant scope/token-input compatibility have
never been tested here. Real credentials or provider calls require authorization.
Claude transparent session continuation after an expiry stop is deferred; this
does not require another login during normal grant refresh.

E2B remains the intended compute backend. No E2B call, sandbox, credential grant,
secret import/write, sign-in, deployment, push or PR was performed. A verified
owner isolation boundary and chosen topology are still required; per-run config
directories and a shared OS user do not isolate credentials against shell tools.
The bounded lifecycle-only E2B validation proposal and estimated cost are in
[the backend design](cloud-computer-backend.md#10-next-authorized-acceptance-gates).
It is a proposal requiring authorization, not a pending or completed operation.

The branch began at `7d7a345fc5801c34e9d664dff1c9dd7556448fc2`. Read-only fetch
verified main now `5a0e1c411f487fee433c48414f7130d0d58dad92`, whose only additional
file is the original cloud-computer handoff (#173). This branch preserves the
updated owner-isolation corrections; it has not been rebased onto that doc.
