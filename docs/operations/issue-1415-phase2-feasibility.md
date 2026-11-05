# Issue #1415: independent API feasibility checkpoint

Research checkpoint, 2026-11-05. Source baseline: `c6261eae42e15ac83bbeab2c19ffda41ea6c649d`, including main `a1b633178`. This document records preparation for [Alex's second-phase instruction](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6664526271). It does not mark the first-phase acceptance complete or start the migration. No deployment, production configuration, provider configuration, new cloud identity or new resource was changed during this research.

Authorization update: [Alex's later decision](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6667238449) permits the necessary merge, production cutover and acceptance decisions, with [resources used only as needed and stopped promptly](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6667340920). References below to a separate production approval describe the earlier research boundary; the technical verification and rollback obligations remain applicable.

## Supported architecture

Use one Vite frontend for web and desktop, retaining the existing components, styles, fonts, translations and live invalidation keys. Keep platform differences in the existing host adapters. The current first-phase renderer builder uses **esbuild**; moving it to Vite is additional second-phase work.

Use Hono for the independent HTTP API and **Nitro v3 with `workflow/nitro`** for its build/runtime integration. This is the Workflow SDK's documented Hono integration. Hono by itself does not compile `use workflow` / `use step`, register the generated workflow metadata used by `start()`, or produce the queue and webhook handlers. Nitro can build the same API for a local Node process and the Vercel Build Output API. The frontend remains a static SPA; it need not become a Nitro-rendered frontend.

Keep the API at the existing origin and `/mikka` base path. This avoids changing the browser's cookie, CSRF and OAuth origin model. Keep generated Workflow handlers ahead of the application's catch-all, and route API/machine requests before any SPA fallback. A missing API path must retain its API error response, not receive `index.html`.

The installed versions are `workflow@5.2.3`, `@workflow/nitro@5.0.6`, `@workflow/next@5.0.6`, `better-auth@1.7.12` and `hono@4.13.13`. Nitro and Rollup are not yet installed as application dependencies; select and pin the Nitro 3 toolchain during the compatibility spike. The umbrella `workflow` package includes `@workflow/next`, whose `next` peer is optional. Removing the application dependency on Next does not require forking Workflow or removing its unused adapter package.

## Actual migration surface

Counts below use tracked sources, excluding generated Workflow routes and temporary acceptance files. The issue's earlier route count is no longer current.

| Surface | Current inventory | Migration obligation |
| --- | --- | --- |
| Server Actions | 212 exported async functions in 37 modules | Preserve behavior and original authorization; replace client transport with typed, validated RPC. |
| HTTP route handlers | 214 tracked files | Preserve URL, method, status, headers, body, streaming and cancellation. Includes the two OAuth discovery documents. |
| HTTP methods | GET 136, POST 114, DELETE 14, PATCH 12, PUT 5, OPTIONS 2 | Generate a contract inventory that includes re-exports and destructured auth handlers. |
| Pages | 21 tracked pages | Preserve redirects, auth recovery, invitations, device approval, sharing, metadata and deep links. |
| Workflow entry files | 8 | Coordinator, due timer, wake recovery, subagent, Factory stage, publication, Slack and thread machine. |
| Framework response APIs | 77 files import `next/server`; 73 import `NextResponse` | Standard `Request`/`Response`, explicit cookie mutations and a supported background scheduler. |
| Request context | 35 files import `next/headers` | Request-scoped headers, cookies, authenticated identity and response mutations. |
| Server localization | 37 files import `next-intl/server` | Validated request locale plus framework-independent message formatting. |
| Auth adapters | 2 files import `better-auth/next-js` | Mount the standard auth handler and preserve cookies from direct server API calls. |
| Server graph boundary | 306 modules import `server-only` | Keep an explicit browser build failure for server imports; retain a server-side no-op marker as appropriate. |

The first-phase RPC registry has 180 original actions plus three desktop helpers. The renderer imports 159 action names and all are covered. The remaining 32 exported functions are **not** automatically public RPC endpoints: examples include the full Coordinator reader and credential/device helpers. The second-phase web bundle must produce its own import manifest; expose only necessary methods with explicit parameter schemas. Internal functions can remain internal while their callers migrate.

## Compatibility boundaries to implement

### Request scope and authentication

Replace the Next header/cookie APIs with an application-owned request context backed by `AsyncLocalStorage`, installed at the independent API boundary. Keep request identity separate from caller-provided parameters and workspace selectors. Preserve multiple `Set-Cookie` headers, deletion attributes and cookie scope. `lib/session.ts` currently uses React's server-render `cache`; its replacement must memoize only within one request, never across users.

Mount Better Auth's standard `auth.handler(request)` at the full configured `/mikka/api/auth` path. Preserve the GitHub callback interception and email verification navigation response in the existing auth route. Next currently strips the base path and the route adds it back; the new server must establish one canonical URL convention instead of accidentally doubling it.

Removing `nextCookies()` requires explicitly forwarding cookies from direct `auth.api.*` calls to the response. This covers password rotation, account switching and other mutating calls, not only browser OAuth endpoints. The original human, mobile, PAT, MCP, device and run-scoped credential boundaries remain distinct.

The desktop RPC endpoint remains bearer-only and ignores authentication cookies. Add a browser transport with its own session-cookie and same-origin CSRF rules over the shared registry/codec; do not make the desktop endpoint accept cookie-only calls. Preserve action limits, strict schemas, safe error codes, version compatibility and the private main-process password-rotation header.

### Workflow runtime

The supported Nitro 3 path compiles the workflow and step handlers into its server runtime and declares Vercel queue triggers. It creates a combined flow handler at `/.well-known/workflow/v1/flow` and a webhook handler at `/.well-known/workflow/v1/webhook/:token`; the step registration module is internal, not another HTTP route.

The compatibility spike must prove the existing `/mikka` exposure and local callback base URL. `@workflow/nitro@5.0.6` registers its internal paths without an application prefix; do not assume that setting a frontend base path prefixes queue/webhook routes correctly. Inspect the generated function rules and exercise sleep, hook, retry and restart through the actual local server.

Keep the workflow source paths, exported names and repository-level project root stable and compare generated IDs. Nitro uses `workspaceDir` as the compiler project root. Preserve the queue namespace, sequential replay behavior, runtime and maximum duration. The generated flow function must have the Workflow queue trigger, not merely an HTTP route.

Existing Vercel runs are pinned to their original deployment. A cutover must retain those deployments and their queue routing for active runs; do not redirect an old run into the new bundle or describe that as a migration. Local resume tests prove local persistence, not production queue acceptance. Actual Vercel deployment testing remains outside the authorized branch work.

Vercel World also requires the real `VERCEL_DEPLOYMENT_ID` in the function environment. It differs from the application's selected build/skew identifier. A forced `WORKFLOW_TARGET_WORLD=vercel` does not replace that requirement. Read and preserve existing project behavior; no project-setting change is needed for the branch-only prebuilt validation.

### Tracing and background work

`instrumentation.ts` starts the existing tracing provider before application database use. `lib/tracing/node.ts` sets `requireParentSpan: true` on PostgreSQL instrumentation and currently relies on Next's request spans. The new server must establish request root spans, with route templates and the existing sanitization/sampling behavior, before invoking handlers. Simply retaining `startTracing()` would silently lose query tracing.

Initialize instrumentation before importing `pg` in both API and generated workflow execution processes. Keep `pg` and the instrumentation packages external where required for patching. Preserve the existing `withRequestLog`, route ALS, `withDatabaseOperation`, background job labels, workflow step labels, response byte samples and privacy tests. `RouteAttributesProcessor` already supports `http.route`; no fabricated Next span is necessary.

Replace the scheduler behind `lib/background.ts`, and the direct `after()` calls in Slack/Telegram webhook delivery and PostHog flushing, with the runtime's request completion / `waitUntil` support. Preserve the deliberate ALS binding and separate background job span. Do not turn these into untracked detached promises.

### Routing, localization and assets

Carry the behavior from `proxy.ts` and `next.config.mjs`: default Chinese / optional English prefix, locale cookie, legacy locale aliases, workspace slug redirects, device/settings redirects, production preview redirects, discovery documents and legacy-host redirects. The translated auth pages and token-bearing recovery URLs keep their `no-store` / `no-referrer` headers. Preserve existing route-specific CSP, frame restrictions, HSTS and MIME defenses.

`use-intl` provides the framework-independent client provider/hooks and server formatting functions. Keep the current message files and formatting, validate locale per request, and reuse the desktop routing adapters where they fit both hosts. Preserve the exact font-face metrics, theme initialization and static paths. Frontend/public configuration must be an explicit allowlist, never a dump of the server environment.

### Build output and deployment preparation

Generate Vite assets into the static portion of the Build Output API and Nitro's API/Workflow functions into the function portion. Validate the final `config.json`, all `.vc-config.json` files, redirects and route order without uploading them. Preserve Node 24, long-running route durations and coordinator streaming cancellation (`vercel.json` currently enables `supportsCancellation` for that route).

Carry the non-JavaScript traced files from `next.config.mjs` into the new output: cloud worker and E2B scripts, subscription binaries, retained-deliverable inspection and disposable email data. A successful TypeScript bundle does not prove these files exist at runtime.

Keep the migration runner `scripts/migrate.mjs`, its database target checks and its position after a successful build. The branch validates it against isolated PostgreSQL only. Prepare the existing `web-deploy.yml` path for prebuilt output while retaining its main/lock/version guards, but do not trigger its production steps or a Vercel Preview.

## Ordered proof before broad migration

1. Finish first-phase acceptance on its fixed code and environment.
2. Build a small independent API target with the installed Workflow version, a pinned Nitro 3 toolchain and unchanged workflow source roots. Exercise a real local workflow's start, sleep/resume, hook, retry and process restart; inspect all prebuilt flow triggers and runtime paths. This proves the compiler/runtime seam before moving hundreds of routes.
3. Install request context, auth response-cookie propagation, same-origin browser RPC, tracing roots and background scheduling. Run existing real-session and tenant tests against both browser and native transports.
4. Move the route inventory and web action consumers without changing stores or narrowing/expanding business permissions. Preserve the newly bounded Coordinator summaries and request-scoped data caches from main.
5. Build web and desktop from the shared Vite UI. Verify every old route, query parameter and native entry point; compare screenshots under identical fixtures, fonts, theme and dimensions.
6. Compare baseline and migrated local production builds on the same Medium machine: cold dev start, HMR, build wall time/peak memory, idle requests, query count and actual database bytes. Keep the no-polling policies and existing <=0.1% screenshot gate. A smaller bundle alone does not establish these results.
7. Validate branch-only prebuilt functions and a version-bound rollback/cutover document. Leave production deployment approval as the separate final operation required by Alex's instruction.

## Real-provider OAuth feasibility

The existing [acceptance policy](../acceptance.md) requires actual Google/GitHub provider round trips for OAuth/callback/linking acceptance. A leased email account and successful native PKCE exchange establish application handoff behavior, not provider identity acceptance.

The documented existing cloud path is the GitHub branch OIDC workload identity in [Infisical configuration](../infisical-cloud.md), reading `staging:/vercel`. It is already used by the branch-push `cloud-secret-access` CI job. No additional identity or credential store is needed. The six relevant names are `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_OAUTH_PROXY_URL` and `BETTER_AUTH_OAUTH_PROXY_SECRET`. The stable proxy hub remains unchanged; the disposable backend requires its exact public origin, its own isolated database and its own Better Auth session secret.

A concrete preparation path is to read only these selected staging keys through the existing branch-push OIDC job, keep them in process memory, and transfer them through an authenticated encrypted connection to the attested disposable backend. Do not write them to artifacts, reports, repository environment files or shell command text. Confirm the target SHA/origin/database and Better Auth proxy version compatibility before restarting the disposable backend. This is a proposed credential delivery step, not evidence that it has run.

The available browser plugin currently reports: `Browser access requires the originating browser context. Open ChatGPT in the browser with the connected extension and try again.` No authorized Google/GitHub browser session has been observed by this agent or the root agent. No browser fallback was initialized and no provider login was attempted. This is the remaining external-provider acceptance gap; delivering application credentials alone does not resolve it. Preserve any `account_not_linked` ownership conflict as a separate provider result.

## Primary references

- [Workflow SDK Hono integration](https://workflow-sdk.dev/docs/getting-started/hono), also bundled with `workflow@5.2.3` under `docs/getting-started/hono.mdx`.
- [Workflow framework integration contract](https://workflow-sdk.dev/docs/how-it-works/framework-integrations).
- [Workflow Nitro module](https://workflow-sdk.dev/docs/api-reference/workflow-nitro).
- [Workflow deployment behavior](https://workflow-sdk.dev/docs/deploying) and [deployment pinning](https://workflow-sdk.dev/docs/errors/deployment-mismatch).
- [Nitro Vercel output and per-route function configuration](https://nitro.build/deploy/providers/vercel).
- [Vercel Build Output API primitives](https://vercel.com/docs/build-output-api/primitives).
- [Better Auth Hono integration](https://better-auth.com/docs/integrations/hono) and [OAuth proxy](https://better-auth.com/docs/plugins/oauth-proxy).
- [Framework-independent `use-intl`](https://next-intl.dev/docs/environments/core-library).

The architectural recommendation is an inference from these supported interfaces and the repository inventory. No Hono/Nitro build, deployment, performance improvement or real-provider success is claimed by this checkpoint.
