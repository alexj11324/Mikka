# Issue #1415: independent API feasibility checkpoint

This is the fixed 2026-11-05 feasibility checkpoint and proposed work at that
revision. Its probe results, failed attempts and baseline counts remain
historical evidence. The application migration is implemented in
`apps/frontend` and `apps/api`. Use [the runtime guide](web-runtime.md) and
[deployment guide](web-deploy.md) for operating instructions, and
[the final report](../acceptance/issue-1415/final-report.md) for later acceptance.

Updated 2026-11-05. **A small Hono/Nitro application now has real Node evidence for Workflow retry, sleep, hook, return value and recovery of a pending timer after process restart.** Two integration fixes were necessary: explicit Local World startup/shutdown and preserving its actual package metadata in the output. This establishes the framework seam; it does not establish Mikka's application migration, first-phase acceptance, production durability or a performance improvement. The complete sanitized evidence, source/archive hashes and retained failures are in [workflow-runtime-feasibility.json](../acceptance/issue-1415/workflow-runtime-feasibility.json).

This remains preparation for [Alex's second-phase instruction](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6664526271). First-phase acceptance precedes application migration. [The later ownership decision](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6667238449) authorizes the necessary merge, production cutover and acceptance decisions, with [resources used only as needed and stopped promptly](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6667340920). This preparation changed no product implementation, deployment, production/provider configuration, cloud identity or application database.

## 1. What the independent probe proved

The probe used Workflow 5.2.3, `@workflow/nitro` 5.0.6, Local World 5.1.2, Hono 4.13.13, Nitro 3.0.261103-rc and Rolldown 1.3.0 on Node 24.22.1 / Linux x64 / ABI 137. Its Node and Vercel targets initially built on the agent VM. Because that VM prohibits listening sockets, runtime validation reused the already authorized Large sandbox, UID 2002, a private temporary directory and one loopback listener. The process environment contained only explicit OS and Workflow local settings; it inherited no application database, authentication or Docker credentials. No model or external provider was called. [Evidence](../acceptance/issue-1415/workflow-runtime-feasibility.json)

Exactly **two workflow runs** were created. The workflow's step deliberately failed once with `RetryableError`, succeeded on attempt two, slept for five seconds, waited on a hook and returned the supplied accepted value. Later recovery attempts reused the second run and its unchanged persistence directory; they made no new start request.

| Attempt / UTC interval | Observed result | Consequence |
| --- | --- | --- |
| 355, 22:30:03–22:30:32 | Ordinary execution passed: one retry, two step attempts, 5,016 ms sleep, one hook/resume and the expected return value. The second run reached `wait_created` before shutdown. The listener closed, but queue retries kept Node alive; the driver eventually used SIGKILL and recorded `PROBE_GRACEFUL_STOP_FAILED`. | The original attempt remains failed. Constructing a World or reading `getRun().status` does not start Local World's active-run recovery, and closing the listener does not close its queue. |
| 367, 22:38:53–22:39:34 | An explicit startup/close plugin exposed `initDataDir` rejecting the fallback package version `bundled`. The pending history remained unchanged. Formal shutdown succeeded in 1,065.967 ms. | The SDK must retain its real package metadata. A fabricated version or edited persistence file would hide the defect. |
| 373, 22:43:59–22:44:01 | With the real Local World package traced into the output, startup automatically recovered the original wait and reached `hook_created` before any status read or resume. One resume completed that same run. SIGTERM plus `world.close()` exited zero in 1,015.536 ms, inside the installed srvx five-second shutdown deadline. | The independent Node lifecycle/recovery case passed, with both earlier failure reports unchanged. |

The recovered wait took 828,242 ms of wall time, including diagnosis downtime after the original deadline. This proves recovery of an overdue persisted wait, not timer latency or throughput. Final read-only verification found exactly two completed runs, all six owned runner/Node PIDs absent and the loopback port closed. Only the private evidence directory was retained; the credential controller was closed. [Evidence and limitations](../acceptance/issue-1415/workflow-runtime-feasibility.json)

### Exact tested Node integration

The [official Hono integration](https://workflow-sdk.dev/docs/getting-started/hono) uses Nitro with `workflow/nitro`; Hono alone does not compile workflow/step directives or emit the handlers. The following is the actual independent probe configuration, not a change to Mikka:

```ts
// nitro.config.ts — pinned Nitro 3.0.261103-rc
import { defineConfig } from 'nitro'

export default defineConfig({
  modules: ['workflow/nitro'],
  plugins: ['./plugins/workflow-world.ts'],
  rolldownConfig: { external: ['@workflow/world-local'] },
  traceDeps: ['@workflow/world-local*'],
  routes: { '/**': './src/index.ts' },
  compatibilityDate: '2026-11-05',
  workspaceDir: import.meta.dirname,
})
```

```ts
// plugins/workflow-world.ts — official World lifecycle, local target only
import { definePlugin } from 'nitro'
import { useNitroHooks } from 'nitro/app'
import { getWorld } from 'workflow/runtime'

export default definePlugin(async () => {
  if (process.env.WORKFLOW_TARGET_WORLD !== 'local') return
  const world = await getWorld()
  useNitroHooks().hook('close', async () => {
    await world.close?.()
  })
  await world.start?.()
})
```

The actual build command was `node node_modules/nitro/dist/cli/index.mjs build --preset node-server`. Nitro 3 exports `definePlugin`; this is not the older `defineNitroPlugin` API. Registering the close hook before awaiting startup also permits cleanup when startup fails. Installed Local World's `start()` initializes its data directory and re-enqueues active runs; `close()` closes the queue and transport resources. The plugin is explicitly conditional on `WORKFLOW_TARGET_WORLD=local`: it does not prescribe lifecycle behavior for a Vercel production World.

The final archive contained 391 regular files, including the real `@workflow/world-local@5.1.2` package and its `package.json`. Its `init.js` matched the installed SDK byte for byte. No SDK source, internal cache or stored version was patched. A separate local initialization check wrote the expected `@workflow/world-local@5.1.2` version marker and closed cleanly without starting a workflow. Configuration, plugin, lockfile, entry and archive hashes are retained in the [evidence](../acceptance/issue-1415/workflow-runtime-feasibility.json).

### What the Vercel build proves

The initial compile-only Vercel output used `nodejs24.x`, response streaming, a flow function with `maxDuration: "max"`, and a `queue/v2beta` trigger for `__wkf_workflow_*`, consumer `default`, retry after five seconds and no initial delay. It generated `/.well-known/workflow/v1/flow` and `/.well-known/workflow/v1/webhook/:token` ahead of the application catch-all. These are build facts from the pinned output, not evidence of a deployed queue round trip. The final lifecycle/external-package configuration was rebuilt for **Node only**; regenerate and inspect its Vercel output before migration acceptance. No output was uploaded or deployed. [Build evidence](../acceptance/issue-1415/workflow-runtime-feasibility.json), [Nitro provider contract](https://nitro.build/deploy/providers/vercel)

## 2. Minimum application architecture

Use one Vite frontend for web and desktop, retaining the current components, styles, fonts, translations, live invalidation keys and authenticated read cache. Keep platform differences in host adapters. The first-phase desktop builder currently uses esbuild, so the shared Vite conversion is additional second-phase work.

Use Hono as the independent HTTP API and Nitro for Workflow compilation and Node/Vercel output. Keep application HTTP at the existing origin and `/mikka` base path. A static frontend does not need Nitro server rendering. Generated Workflow handlers, API and machine protocols must precede SPA fallback; an unknown API URL must retain its API error response.

The smallest implementation boundary is application-owned, with the following proposed modules. These interfaces have not yet been implemented or runtime-validated for Mikka.

| Boundary | Responsibility | First acceptance case |
| --- | --- | --- |
| Request scope | `AsyncLocalStorage` for canonical Request, validated locale, authenticated identity, request memoization and mutable response state. | Two concurrent users/locales cannot share identity, workspace, messages or cookie mutations. |
| Cookie journal and auth facade | Capture every direct Better Auth response cookie, provide read-after-write semantics, finalize headers once before response commitment. | Session refresh, deletion, chunked signed cache, password rotation and account switching retain all cookies. |
| API registry | Preserve explicit HTTP methods, path parameters, status, streaming, redirects and cancellation. | Existing route inventory plus automatic HEAD/OPTIONS and unsupported-method behavior. |
| Shared action registry | Existing closed whitelist, Zod bounds and wire codec; distinct browser-cookie and native-bearer transports. | Original permission/cross-tenant and fresh-session tests pass through each transport. |
| Request lifetime | Response-completion scheduling, runtime `waitUntil`, shutdown drain and detached job spans. | Deferred work runs after a finished/aborted stream with correct context and cannot mutate committed headers. |
| Runtime instrumentation | Initialize tracing before database imports and create request root spans. | Existing query/byte/privacy evidence remains comparable and idle export behavior stays bounded. |

## 3. Version-bound migration inventory

The verified AST inventory is anchored to **`ec9c76a33c605d6b2b4dd7cf9181943cb2901273`**, tree `11206a98a2a226eab14d6279a5c92947d4db4edd`. It parsed 4,014 code files from verified Git blobs without executing route/auth/config modules. Its source hashes, summary and analysis artifact hashes are preserved in [the evidence inventory section](../acceptance/issue-1415/workflow-runtime-feasibility.json). These are fixed-baseline counts, not a claim about a moving branch; regenerate the inventory at the application migration freeze.

| Surface | Verified inventory | Migration obligation |
| --- | --- | --- |
| Tracked HTTP route modules | 216: 181 API, 32 v1, two discovery documents and one workspace link | Preserve each original URL, body, authorization and response contract. |
| Explicit method bindings | 286: GET 138, POST 115, PUT 5, PATCH 12, DELETE 14, OPTIONS 2, HEAD 0 | Follow real exports, including aliases/re-exports; do not expose extra methods merely because an SDK supports them. |
| Structural bindings with Next defaults | 638 | Automatic HEAD still passes a HEAD Request into the GET handler; its SDK may refuse it. This count does not promise 638 successful responses. |
| Locale pages / Server Action modules | 21 / 37 | Preserve auth recovery, invitations, device approval, sharing, metadata, deep links and the actual client import manifest. |
| Framework usage | 166 Next imports; 506 classified calls | Separate client navigation from server context/control flow. |
| Direct server context calls | `headers` 55, `cookies` 19, `NextResponse` 335, `after` 3, `redirect` 11, `notFound` 6 | Replace ambient context and control-flow behavior, not just import names. |
| Direct Better Auth calls | 151 calls across 15 methods | Cookie-producing reads and direct writes both require response propagation. |

There were zero AST parse errors, unresolved HTTP exports or duplicate route patterns. Generated Workflow handlers are additional: the pinned builder declares flow GET/HEAD/OPTIONS/POST, webhook handlers for all seven supported HTTP methods, and a conditional public manifest. Their final paths and output rules require build verification.

Do not automatically expose every exported server function. The desktop import manifest and explicit registry remain the authority; second-phase web imports need their own coverage check. Preserve main's bounded Coordinator summaries, cache-aware detail continuations and narrow identity-only thread reads. A transport migration must not restore the full `getCoordinatorChat` endpoint or replace a narrow read with a full payload. [RPC registry](../../lib/desktop-rpc/registry.ts), [schemas](../../lib/desktop-rpc/schemas.ts), [Coordinator actions](../../app/actions/coordinator.ts), [thread actions](../../app/actions/agents.ts)

## 4. Hard compatibility boundaries

### Request URL, HTTP behavior and response commitment

Establish one canonical full URL, including `/mikka`. The current [auth route](../../app/api/auth/[...all]/route.ts) restores the base path that Next stripped; an independent server must not strip and then accidentally double it. Retain GitHub callback interception and verification navigation. Preserve the original Request method, body and abort signal when adapting it. The current auth wrapper reconstructs a Request; preserving cancellation in the new boundary must be explicit.

Use the inventory's explicit method table rather than `app.all()` everywhere. Next's automatic HEAD/OPTIONS, sorted Allow header, empty 204, explicit OPTIONS priority and 400/405 behavior are observable contracts. Pages and API handlers have different defaults. Preserve SSE, MCP streamable HTTP, Range/HEAD, binary artifacts, redirects and `no-store`; do not serialize every handler as JSON or buffer every stream. [Global routes](../../proxy.ts), [configuration](../../next.config.mjs), [workspace redirect](../../app/w/[slug]/route.ts)

The cookie journal needs both incoming cookies and pending mutations. Reads after a mutation must see the new value. Keep separate cookie fields until finalization, including distinct paths, deletion attributes, secure prefixes and contiguous signed-cache chunks. Node 24's `Headers.getSetCookie()` can expose individual headers; use the locked SDK's cookie parser where structured options are necessary. Never split a combined cookie string on commas: an Expires date contains a comma. Finalize the response exactly once before its stream starts; reject later header/cookie writes. Auth's HTTP handler already returns its own headers, so its cookies must not also be appended through the direct-call path.

### Better Auth and read budgets

Better Auth's [standard Request/Response handler](https://better-auth.com/docs/integrations/hono) can run under Hono. Mikka still needs its current GET/POST exposure, wrapper behavior and hooks. In [auth.ts](../../lib/auth.ts), `nextCookies()` is the last plugin and carries cookies from direct `auth.api.*` calls into Next's response. Removing that plugin without a replacement loses session renewal, cache invalidation, profile changes, sign-out, password rotation and multi-session state. Even `getSession` can renew or clear a cookie, and Mikka's `/get-session` after hook can add a multi-session cookie.

The proposed direct-auth facade must request the SDK's response headers (`returnHeaders`/`asResponse` as appropriate to the pinned method), capture all returned cookies in the current response journal, and preserve the original method result. Do not force all calls through a synthetic extra HTTP request. Keep `auth.handler` router responses distinct from direct calls. Installed `nextCookies` also suppresses refresh in an RSC read identified by `RSC: 1` without `next-action`; replace that semantic deliberately at the appropriate browser read boundary, rather than letting an arbitrary caller header weaken freshness. [Fresh-session policy](../../lib/fresh-session.ts), [session helper](../../lib/session.ts)

Keep the existing seven-day session, one-day update interval and five-minute **SDK-signed** read cache. Request-scoped reuse alone is insufficient: a fresh database lookup on every native read adds authentication queries compared with the original web read. Sensitive money, credential, permission and deletion operations must still upgrade to a fresh database-backed session. Preserve expiry, revocation, token binding and a rejected fresh lookup remaining rejected; do not fall back to cookies or an older cached principal. The existing cache budget, tamper/cross-account and fresh-write tests remain mandatory. [Authentication scope](../../lib/desktop-rpc/authentication.ts), [signed cache](../../lib/desktop-rpc/session-cache.ts), [RPC session scope](../../lib/desktop-rpc/session.ts)

Keep desktop RPC bearer-only. Browser cookie authentication belongs to a separate same-origin/CSRF-checked transport over the same registry and codec. Native main strips renderer-supplied Cookie/Authorization and attaches the real session bearer. Its private `x-mikka-session-cache` contract remains absent = unchanged, empty = clear, bounded valid proof = replace; SDK chunk reconstruction and password-rotation headers stay in main. Preserve protocol v1/v0, 426 `desktop_client_update_required`, safe public session projections and 409 for a stale owner's in-flight response. Switching workspace only carries the validated UUID selector bound to that account. [RPC boundary](../../lib/desktop-rpc/handler.ts), [main auth](../../apps/desktop/src/main/bundled-auth.ts), [protocol](../../apps/desktop/src/main/bundled-protocol.ts)

The browser → return 303 → exact loopback → one-use PKCE exchange must remain real. State, verifier and bearer stay in main, and encrypted persistence completes before the renderer receives a safe session. Preserving an email-session test does not prove Google/GitHub provider login. [Loopback](../../apps/desktop/src/main/bundled-loopback.ts), [desktop routes](../../app/api/desktop)

### ALS, workspace and locale

Replace React server-render `cache` with request-local memoization, not a global TTL cache. The request scope should hold immutable authenticated identity and explicit freshness state, separately from the user-supplied workspace selector. Existing `readWorkspaceContext` checks membership and PAT confinement; it can also ensure a personal workspace/share and rename a generated workspace according to locale. A wrong default locale can therefore change stored data, not merely display text. [Workspace access](../../lib/workspace-access.ts)

Use the existing message files and framework-independent `use-intl` formatting. Derive locale once from the existing validated web routing/cookie rules, or the authenticated native `x-mikka-locale` header, and keep it in the same request scope. Preserve default `zh-CN`, optional `/en`, aliases, locale cookie and Accept-Language negotiation. Concurrent English/Chinese requests and captured background work need an isolation test. An unvalidated header or module-global locale is not a replacement for `setRequestLocale`. [Request locale](../../i18n/request.ts), [routing](../../i18n/routing.ts), [use-intl interface](https://next-intl.dev/docs/environments/core-library)

The shared read cache still reauthorizes before serving cached detail and keys work by the correct user/workspace/version/continuation. Keep continuation bounds, restored tool metadata and narrow invalidation. Frontend bootstrap must continue returning the server-evaluated feature snapshot and cache workspace before rendering; never expose a dump of server environment variables.

### `after`, response lifetime and tracing

This is a remaining application integration gate. [`afterJob`](../../lib/background.ts) creates a detached job span, with optional ALS retention around the **job wrapper**. Binding the task body instead would restore request context over the job's route/label. Direct `after()` also appears in Slack/Telegram delivery and PostHog flushing. Preserve these semantics when replacing Next's scheduler; detached promises alone do not preserve serverless lifetime.

The proposed request adapter needs separate phases: run the handler under request ALS, finalize cookies/headers, commit and stream the response, then run queued completion work under its captured context and independent job span. A stream abort/error must still close the request lifetime and schedule permitted completion work. Background callbacks cannot modify already committed cookies. Node shutdown must drain owned work; Vercel must register the actual pending work with its runtime `waitUntil` before invocation lifetime ends. Avoid delaying a webhook acknowledgement behind its downstream work.

There is a concrete pinned Nitro Vercel integration point: `nitro/dist/presets/vercel/runtime/vercel.node.mjs` reads `Symbol.for('@vercel/request-context')`, attaches its context to `req.runtime.vercel` and assigns `req.waitUntil = context.waitUntil`. That is installed-source evidence, **not proof that Hono `c.executionCtx` exists in the Node preset**, nor that a generic Nitro response hook runs after the entire body has finished. The first application spike must map actual response finish/close/abort to the scheduler. If necessary, a Node entry adapter owns those events explicitly; do not infer stream completion from a Response object being returned.

Initialize existing tracing before importing `pg`, in both API and Workflow execution entry points. [`lib/tracing/node.ts`](../../lib/tracing/node.ts) uses PostgreSQL `requireParentSpan: true`; removing Next's root spans without adding request spans silently loses query traces. Preserve route templates, privacy/sampling filters, database-operation/response-byte labels and independent background spans. Keep the failed-export pause and idle behavior. The successful Local World externalization does not validate PostgreSQL instrumentation: package externalization and import order need their own focused trace test. [Instrumentation entry](../../instrumentation.ts), [tracing contract](tracing.md)

### Workflow paths and delivery output

The probe mounted application endpoints under `/mikka`, while Nitro's generated Workflow endpoints remained at root `/.well-known/workflow/v1/...`. It did not prove a full Mikka base-path migration. Compare the original Next output's public handlers and queue metadata with the new output and preserve the required mapping explicitly. Keep workflow source paths, exported names, project root (`workspaceDir`), queue namespace and generated IDs stable where required.

Existing Vercel runs remain pinned to their original deployment and queue routing. Do not redirect them into a different bundle and call that migration. Retain old deployments during cutover and validate the supported deployment-pinning behavior. Local World is a single-process development backend with filesystem persistence and an in-memory queue; its recovery proof does not establish Vercel or PostgreSQL production durability. [Workflow integration contract](https://workflow-sdk.dev/docs/how-it-works/framework-integrations), [deployment pinning](https://workflow-sdk.dev/docs/errors/deployment-mismatch)

Merge Vite static assets and Nitro functions into branch-only Build Output API artifacts with explicit route order. Preserve Node 24, long route durations, coordinator streaming cancellation, security headers, auth/recovery `no-store`/`no-referrer`, frame restrictions, CSP, font metrics and theme initialization. Keep non-JavaScript traced inputs from `next.config.mjs`: cloud/E2B scripts, subscription binaries, retained-deliverable inspection and disposable email data. A successful JavaScript bundle does not prove these files are present. [Build output contract](https://vercel.com/docs/build-output-api/primitives)

Retain [`scripts/migrate.mjs`](../../scripts/migrate.mjs), target guards and the existing build/deploy sequencing. Branch acceptance uses isolated PostgreSQL. Preserve main/lock/version guards in the prebuilt deployment path. No Vercel Preview or upload is needed to inspect the output; production cutover follows the authorized issue sequence and its actual acceptance gates.

## 5. Ordered implementation and remaining proof

1. Finish phase-one acceptance on its fixed product, harness and environment; regenerate the version-bound inventory when phase two starts.
2. Carry the tested Workflow lifecycle/package integration into a minimal API target and regenerate both Node and Vercel outputs. Validate existing workflow IDs, base-path mapping, generated handlers and queue triggers before moving business workflows.
3. Implement request ALS, cookie journal, direct-auth facade and browser/native transport boundaries. Reuse real-session, cross-tenant, cache-budget, rotation and multi-account tests; add concurrent locale/context and multi-Set-Cookie cases.
4. Prove response-finish/abort scheduling, runtime lifetime and OTel import order on the small target. A stream, immediate JSON response, rejected handler and webhook acknowledgement must each retain their intended cleanup/background behavior.
5. Move the route inventory and actual client action consumers without changing stores or permissions. Keep machine tokens, MCP, device/live, artifacts, bounded reads and cached-detail authorization intact.
6. Build both hosts from the shared Vite UI, then verify routes/query parameters, deep links, PKCE and identical-fixture screenshots. Compare cold start, HMR, full build time/peak memory, idle requests, query count and actual database bytes against the fixed baseline on the same suitable machine. Preserve the existing no-polling and screenshot thresholds; no performance result is implied by this probe.
7. Inspect branch-only prebuilt artifacts, migration guards and a version-bound rollback/cutover plan. Production verification must exercise real business workflows and the relevant auth/provider paths; the independent two-run probe is supporting evidence only.

## 6. Real-provider OAuth remains a separate boundary

The [acceptance policy](../acceptance.md) requires real Google/GitHub round trips for provider/callback/linking acceptance. Leased email accounts and native PKCE prove application handoff behavior, not provider identity acceptance.

The existing cloud credential path is the branch OIDC workload identity documented in [Infisical configuration](../infisical-cloud.md), reading selected keys from `staging:/vercel`. The relevant names are `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_OAUTH_PROXY_URL` and `BETTER_AUTH_OAUTH_PROXY_SECRET`. The stable proxy hub remains unchanged; a disposable backend needs its exact attested public origin, isolated database and own session secret. No new identity or credential store is required.

A proposed delivery step can keep those selected values in process memory and send them over an authenticated encrypted connection after verifying SHA/origin/database and proxy compatibility. Do not put them in artifacts, logs, repository environment files or shell command text. This preparation has not performed that transfer. No authorized Google/GitHub browser session was observed in the earlier feasibility check, and no provider login was attempted. Public email self-registration can establish a usable disposable application login, but cannot close the external-provider acceptance gap.

The architecture recommendation is an inference from the pinned source inventory, documented framework interfaces and the narrow real runtime evidence above. Mikka's request/auth/background adapters, business workflows and deployed production queues remain explicit verification work.
