# Shared image and history read compatibility

This candidate is based on frozen main `470c5cd4873634ff2b992598349ab52cffe1ee62`. It changes only the image loader's canonical GET path and adds retained-read regression coverage. It does not retire or restore POST generation on this base; runtime retirement remains PR293/PR300 integration. No Coordinator hotfiles, provider implementation, UI layout, data schema or configuration changes.

## Keep at integration

- Main's `app/api/agent/images/route.ts` and `app/api/agent/sessions/route.ts` have `withRequestLog`/`noteLogUser`; retain them. The older PR293/PR300 snapshots lack these later logging additions. New handler tests execute those real GET functions with auth/transport/reader stubs and assert their private/no-store responses, authenticated owner forwarding, input rejection, cancellation signal and safe logs. They are not a replacement for real owner-isolation database tests.
- Keep main's `app/api/agent/sessions/active/route.ts`, `lib/active-agents.ts` and `test:active-agents` entry (9760e91). This reports current Coordinator/worker execution state; it is not standalone chat generation. Its absence from an older candidate is not authorization to remove it.
- Keep PR63 merged commit `372bfe76a8452f03cbb82dfc184af54015e0a107` and subsequent main history. Its standalone POST SSE thinking/searching/timing hooks become inapplicable after runtime retirement; do not reintroduce that POST to retain them. Current Bot status/first-response behavior must be checked in the S/R-composed Bot path. This patch does not port the old SSE protocol.
- `GET /api/agent?q=` remains a compatibility alias to the image handler in retirement candidates. Canonical new client requests use `/api/agent/images?q=` with the existing base path. Never replace the alias with a generation POST.
- Keep all current main package scripts. Add `test:legacy-reads`; do not replace the whole package.json from an older candidate. On auth-R0 stacks this new test entry needs that owner's explicit recipe inventory; do not weaken the runner.

## Old issues and PRs

PR61 `d035f66fd3d317c5113d059b9973ea7c130237a7` fixed an absent GET. Main already has a working GET alias, so its original404 root cause is superseded. This patch preserves its useful canonical-path/encoding regression independently of retired Agent UI mocks. Its old generation-based image browser tests must not be revived. The new focused browser test uses a persisted current Coordinator reply and controlled image transports, never a model or legacy POST.

PR63 is merged; merge status alone does not demonstrate first-response performance. PR293's frozen78e079a proved7 actual Next/browser retirement cases, but main470c5cd still contains old POST and the final current-Bot composition remains separate. For issue167, do not check off63 performance acceptance merely because its code merged.

Issue100 provider and durable search/scrape registration belongs to S's current Bot work (PR295/PR300). PR290 is the wrong retired runtime and stays HOLD. This image/history patch neither calls Firecrawl nor proves live-provider completion. Preserve the `notice:search_degraded` contract in that separate composition.

## Checks

`test:legacy-reads` runs9 focused source/real-handler tests without network, DB or credentials; `test:request-log` adds5 existing logger tests. A dedicated cloud workflow runs actual Next HTTP auth/cross-site checks on both image GET paths and a saved current Bot reply through the unchanged shared renderer. Its public image and image API transports are controlled; it is not real Wikimedia/Firecrawl provider acceptance. Only synthetic fixture data is inserted into guarded Actions loopback mikka_e2e. The workflow reuses S's immutable test-only PG-extension bootstrap at a8533de, without importing S's runtime code.

Exact run results are recorded in the PR and external handoff after completion. No skipped/default-draft browser check counts as passed. No production SQL, credential/config write, paid API, merge or deployment is authorized here.
