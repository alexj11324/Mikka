# 彻底退役 Next.js 依赖

2026-11-18：Alex「之前我说要退役 next js, 好像并没有做完, 这次把 nextjs 完整退役, 制定计划」。

2026-11-10 的 `072722bdc`（PR #1898）删掉了页面层——27 个 `page.tsx`、`app/[locale]/layout.tsx`、`proxy.ts`、`next.config.mjs`——但明确保留了 `next` 依赖本身、`app/api`、`app/actions`、`next-intl` 和 `apps/api/compat/**`。这次处理的就是剩下的依赖层与兼容层。

## 决定

`next`、`next-intl`、`@vercel/analytics` 不再是依赖；`pnpm why next` 之外的任何地方都不该再出现框架名。

### 各层现在的归属

| 原来 | 现在 | 说明 |
| --- | --- | --- |
| `next/server` | `@/lib/server-runtime/server` | `NextRequest`/`NextResponse`/`NextURL`/`after`，名字保留是因为所有 handler 和测试都在用；它描述形状，不是依赖 |
| `next/headers` | `@/lib/server-runtime/headers` | `headers()` 只读；`cookies()` 返回请求的 cookie journal |
| `next/navigation` | `@/lib/server-runtime/navigation` | `redirect`/`notFound` 抛 `NavigationResponse`，由 `application.ts` 转成响应 |
| `next/navigation`、`next/link`、`next/dynamic`、`next/script`（客户端） | `@/lib/client-runtime/*` | Web 与桌面共用一份；桌面的 `location.ts` 只是转发 |
| `next-intl` | `@/lib/intl/i18n-client` / `i18n-server` | `use-intl` 的薄封装；`next-intl` 本来就是它的 re-export |
| `next/font` 的构建期 Lightning CSS | `lightningcss` + 冻结的 browserslist 目标 | `apps/frontend/scripts/css-targets.mjs` |
| `nextCookies()` | `mikkaCookies()`（`lib/auth-cookies.ts`） | after hook 写进请求的 cookie journal，由传输层提交 |
| `toNextJsHandler` | `auth.handler` | 原实现只是转发 |

### 会话 cookie 的契约

`mikkaCookies` 是 `nextCookies` 的忠实移植：`ctx.context.responseHeaders` 里的 `set-cookie` 经 `parseSetCookieHeader` 逐条写进 `currentRequestScope().cookies`，由 `apps/api/src/application.ts` 在响应边界 `commit`。`auth.api.*` 会跑插件管线（`dispatchAuthEndpoint` → `runAfterHooks`），所以普通 `getSession` 的续期 cookie 也会落进 journal——**不需要**在 `fresh-session` 里再解析一遍（早期实现那样做，反而破坏了 `lib/browser-rpc/session.ts` 主动要 `{headers, response}` 的调用）。

`_flag === 'router'` 的跳过保留：`app/api/mobile/open/route.ts` 依赖它，在用户确认前不能登录。

### 不再有意义的东西

- `export const dynamic = 'force-dynamic'` 与 `export const runtime = 'nodejs'`：`generate-routes.mjs` 只读 HTTP methods 和 `maxDuration`。删掉 305 处后路由清单仍是 368 条 / 485 个方法。
- `instrumentation.ts`：`apps/api/runtime/tracing-start.ts` 已经在构建入口做同一件事。
- `NEXT_PHASE` / `NEXT_DEPLOYMENT_ID` / `NEXT_TELEMETRY_DISABLED`。

## 明确保留

- **`NEXT_LOCALE`**：一年有效期的业务 cookie，改名会让所有用户的界面语言选择静默丢失。
- **`NEXT_PUBLIC_*`**：Vite `define` 白名单的构建期约定，改名牵动 Cloudflare release 的 `publicBuildSettings` 与 receipts。留作独立任务。
- **`next-themes`**：只有 react peer，与 Next 无关。
- **`import 'server-only'`**：仓库自己的编译期标记（`lib/server-only.ts`），不是 npm 包——官方包带 react-server 条件副作用。
- **`scripts/dev-local/reviewed-local-evidence.mjs` 的 `next.config.mjs`**：历史 artifact 指纹必须能重算，删掉这个路径会静默改变所有历史指纹。
- **两个 sandbox 验收脚本的 `next/dist/bin/next`**：它们启动第三方 Next fixture，框架由 fixture 自己安装。
- **`scripts/ui-policy.mjs` / `base-path-policy.mjs` 里的 `next/font`、`next/link` 字符串**：它们是 lint 规则的被拒输入，且同样审计私有 overlay 仓。

## 验收

`node_modules/next`、`node_modules/next-intl`、`node_modules/@vercel/analytics` 在干净安装后都不存在。`pnpm why next` 仍有输出，因为 `next` 是 `better-auth`、`eve`、`@workflow/next` 的 **optional peer**——那是上游元数据，不是本项目的依赖；`autoInstallPeers` 不会把它落进顶层。

`scripts/next-free.test.mjs` 守住这条线：任何重新引入的 import、配置文件、依赖项或 `NEXT_*` 环境变量都会让它失败。

## 取代

[`2026-11-05-1615-desktop-bundled-renderer.md`](2026-11-05-1615-desktop-bundled-renderer.md) 里「web 用 Next.js」的表述，以及 `decisions.md` 中 2026-10-29 那两条提到「共享 Next.js UI」的记录。
