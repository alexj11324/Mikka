# Web 与桌面共享运行时

本文说明 Web、桌面和独立 API 的共享运行时、公开构建与自托管合同。
公司生产部署、账号、切换和验收记录统一从[私有运维入口](README.md)读取。

## 入口与输出

Web 和桌面通过 [`apps/frontend`](../../apps/frontend/vite.config.mjs) 编译同一套现有业务组件。平台适配器处理导航、认证和传输；页面、工作区、聊天和设置继续复用共享组件。生产 Web 的 HTML 入口为 SPA，API 由独立 Hono/Nitro 服务处理。

| 层 | 源入口或配置 | 输出与职责 |
| --- | --- | --- |
| Web 前端 | `apps/frontend/vite.config.mjs`，目标 `web` | `apps/frontend/dist/web`；公开路径 `/mikka/` |
| 桌面前端 | `apps/desktop/scripts/build-renderer.mjs`，目标 `desktop` | `apps/desktop/dist/renderer`；由 Electron 本地协议提供 |
| API | `apps/api/nitro.config.ts`、`apps/api/runtime/entry.ts` | Hono 分派现有业务 handler，Nitro 承担 Node/Vercel 生命周期 |
| Bot Agent | `apps/eve/agent/` | eve 服务；独立会话、事件与 Workflow 队列，部署见 [Bot runtime](eve-runtime.md) |
| Node 产品 | `apps/api/scripts/build.mjs`，`node-server` preset | `.output/`，包含 API、静态文件、运行资源和构建清单 |
| Vercel 产品 | 同一构建脚本，`vercel` preset | `.vercel/output/`，Build Output API v3、函数、静态资源和 Workflow 路由 |

`renderer-manifest.json` 记录目标、`rendererBuild`、实际使用的 `usedActions` 和输入图。构建插件只把真实导入的显式注册动作转换成 RPC，不自动暴露一个模块的全部导出；浏览器图出现服务端运行依赖会失败。Vite 复用根目录 `public`，Web 静态内容随后挂到 `/mikka`。`index.html` 由页面策略返回，不作为绕过语言、安全头的静态文件发布；API、`/v1`、`.well-known` 的未知路径不能得到 SPA 的 200 响应。

CSS 继续经过共享 Tailwind 与 Next 的构建期 Lightning CSS 引擎及目标；Vite 不再进行第二轮 CSS 压缩。Web 保留原 `instrumentation-client`、PostHog 和 VersionGuard；桌面保留原本的本地认证和主进程能力边界。开发模式使用真实 development React 与 React Fast Refresh。

前端配置禁止自动公开任意 `VITE_*` 或服务端环境。只显式编译原来使用的公开值：Computer 的 acceptance/deployment/enabled/mock、应用 build、daemon package、PostHog key、Stripe publishable key、Turnstile site key。其中 Computer deployment 仍来自 `VERCEL_ENV`，不以缺失的同名公开变量关闭既有生产功能。

## 认证、RPC 与版本

| 客户端 | 动作入口 | 身份与请求边界 |
| --- | --- | --- |
| 普通 Web | `POST /mikka/api/rpc` | Better Auth Cookie；`credentials: same-origin`；JSON 与 `x-mikka-rpc: 1`；Origin 和请求 URL 必须匹配服务端配置的应用 origin |
| 本地桌面 | `POST /mikka/api/desktop/rpc` | 既有主进程 bearer；渲染进程只调用本地受控代理；不借用浏览器 Cookie 身份 |

两个入口共用已有显式 action registry、参数 schema、wire codec 和业务权限。Web 不安装 desktop session scope，不改变原 Stripe、账号或 workspace 权限分支；它拒绝 Authorization、`x-mikka-session-cache` 和 `x-mikka-session-token`。桌面私有签名缓存、轮换 token、PKCE、workspace selector、live/viewer 凭据仍由主进程持有。

Wire 使用 `{version, action, args}`；结果为 `{version, ok, result}` 或 `{version, ok: false, error: {code}}`。版本接受范围由现有协议常量控制。共享组件的 server action 调用通过这个边界转发，普通 REST handler 的方法、鉴权、Origin 检查和错误语义继续有效。

Web 的请求内会话复用绑定同一 Cookie 身份；敏感操作仍通过原 fresh-session 路径升级验证。原 Better Auth `nextCookies` 写入经请求 Cookie journal 提交到响应，不能把 `Set-Cookie` 当普通逗号分隔列表。Web 的 SDK 会话仍是身份权威；bootstrap 只提供安全投影。账号切换递增请求代次，旧账号迟到的 401 或响应不得清掉新账号界面。明确切换语言时，Web 恢复原 `NEXT_LOCALE` 的一年有效期、`Path=/mikka`、`SameSite=Lax`；桌面不写这个浏览器 Cookie。

生产构建同时固定源提交、应用 build 和 deployment ID。Web HTML/资源使用同一 deployment ID，静态资源 URL 带 `dpl`，同源 API 自定义请求带 `x-deployment-id`；`/api/version` 保持不绑定旧部署，以供 VersionGuard 检测更新。没有新增全页面 `__vdpl` Cookie。桌面继续使用自身 API 兼容协议，不固定到某个 Web deployment。

## 现有路由与 Next 兼容范围

[`generate-routes.mjs`](../../apps/api/scripts/generate-routes.mjs) 通过 TypeScript AST 读取 `app/**/route.ts` 的导出、re-export 与解构 handler，不执行路由模块。当前 [`routes.json`](../../apps/api/generated/routes.json) 为 version 1、basePath `/mikka`，包含 **240 条路由记录**（2026-11-08 源码快照）；每次增删路由后以生成清单为准。此数量只描述源码清单。它记录方法、源文件 hash、动态参数和 `maxDuration`，另有独立 browser RPC 与 OAuth consent 安全投影入口。

Hono 根据静态优先的匹配规则延迟载入原 handler，保留参数、请求体、流和取消信号。未显式实现的 OPTIONS 返回 204 与 Allow；不支持的方法返回 405。HEAD 可选用 GET handler，但仍传入原 HEAD Request，最终取消并移除响应 body；这不保证业务 handler 自己会接受 HEAD。机器接口没有 SPA fallback。页面的 basePath、语言、尾斜杠、旧域名和安全头由 [`http-policy.mjs`](../../apps/api/runtime/http-policy.mjs) 处理。

服务端 [`compat-aliases.mjs`](../../apps/api/compat-aliases.mjs) 只实现当前业务实际使用的接口：

- `next/server`：Request/Response、带 basePath 的 URL、Cookie、redirect 与 `after`。
- `next/headers`：当前请求的只读 headers 与可提交 Cookie journal。
- `next/navigation`：redirect、permanentRedirect、notFound。
- `next-intl/server` 与本地化导航：原中英文消息、请求 locale 和翻译接口。
- React `cache`：当前请求内的 memo；其他 React 导出继续使用真实 React。

这些适配器不是完整的 Next 实现。Next 仍保留在依赖中，服务于兼容源码、既有测试和 CSS 构建；产品入口不启动 Next server，也不依赖 Flight 传输。新增服务端 Next API 必须先明确其语义和适配测试，不能因类型能编译就假定运行兼容。

## 请求结束、Workflow 与 tracing

请求作用域使用 AsyncLocalStorage 保存真实 Request、Cookie、locale 和请求级缓存。Cookie 在响应提交边界写回。`after` 的生命周期在响应产生前登记到官方 `waitUntil`；回调在真实响应完成或断开后运行，流式响应不能以“已创建 Response”作为结束。嵌套任务加入同一生命周期，运行错误保留闭集诊断。

Workflow 使用官方 `workflow/nitro` 集成，扫描根目录现有 workflow/step。Vercel 由 SDK 生成 flow/webhook、队列 trigger 和函数配置；finalize 仅加启动 wrapper、资源与清单，保留生成的队列信息，不自行替换 managed World。原有部署的未完成 run 必须继续到其绑定部署，不能通过删除旧部署或重定向队列来“迁移”。

`WORKFLOW_TARGET_WORLD=local` 时，插件注册 close hook，再调用官方 World 的 start；关停时调用 close。开发入口为每个端口保留独立本地数据目录。本地 World 的重启恢复验证与 Vercel 托管队列验证是两件事，前者不能证明生产分布式行为。

每个 Node/Vercel 入口先静态载入 `mikka-tracing.mjs`，再动态载入应用图，保证 tracing 初始化早于实际 `pg` 导入；仅靠较晚的 Nitro 插件不满足这个顺序。`pg` 和 OTel 使用真实外部依赖及其 package 元数据。请求 span 按实际响应结束收尾，后台 `after` 工作保留捕获的上下文。真实 HTTP → SQL → 后台任务 trace、流断开和导出结果仍须在固定环境单独验收，不能由 bundle 文件存在推断通过。

## 开发与 Node 启动

要求 **Node 24.x、pnpm 10.34.3**。在已授权的云 Linux、隔离数据库和现有环境交付方式下运行；不把生产凭据写入代码或临时文档。安装使用锁文件：

```sh
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1 --port 3000
```

| 命令 | 当前实际行为 |
| --- | --- |
| `pnpm dev` | Nitro API watch + Vite 同源页面/HMR；内部 API 用独立 loopback 端口；公共入口 `/mikka` |
| `pnpm dev:local` | 既有完整本地循环：同源前端/API、受隔离 guard 保护的数据库、源码 daemon 与 GitHub/邮件等本地替身；不是生产验收 |
| `pnpm build:app` | 构建当前安装的页面与 API。公开 checkout 生成认证和服务状态页面，提供私有 UI 与配对 SHA 时生成官方工作区。默认使用 `node-server`，不执行迁移 |
| `pnpm build` | subscription worker → agent UI 生成 → build:app → 完整 typecheck → **数据库迁移** |
| `pnpm start --hostname 127.0.0.1 --port 3000` | 验证已编译 `.output` 后启动实际 Node 产品；不构建、不迁移 |
| `pnpm --filter @mikka/desktop build` | Electron 主进程/preload 与同图桌面 Vite renderer |

开发入口保留根工作目录用于 Workflow 发现，API proxy 不改请求 origin；页面继续应用同一语言和 HTTP 策略。新增/变更路由会重新生成清单。停止时关闭自己拥有的 Nitro/LocalWorld 和 Vite 连接；无需以反复轮询补偿热更新或业务 live 通知。

[`start-app.mjs`](../../scripts/start-app.mjs) 在导入和监听前检查 `.output/mikka-build.json`、真实 Node 24、preset、revision、锁文件/路由/tracing hash 格式及可选测试 revision 绑定。它保留启动目录；从构建所对应的仓库根目录使用 `pnpm start`。启动时只做有界 `/mikka/api/version` 就绪检查，验证实际 build，随后不新增空闲读取。

发布必须包含完整输出和所需运行依赖，不能只复制 `index.mjs`。finalize 将域名数据、E2B 脚本和已生成的 worker/enrollment 二进制等实际资源复制入 Node 输出或各 Vercel 函数，并记录 hash。独立归档运行还须验证原 `process.cwd()` 资源路径和正式入口；不要绕过启动校验临时拼接部分输出。

Docker 的公开验收入口使用同一次 Nitro 编译图的 `mikka-docker.mjs`；该 adapter 不自行 listen、不安装信号处理器、`trustProxy=false`。外层已核验环境持有 HTTP/WS 监听与 ingress，严格验证固定 origin/Host 后交给真实 Node request；关闭顺序包含响应结束、官方 waitUntil 和 Nitro close。不能用新起的普通 listener 替代这个环境证明。

## Vercel 构建与生产切换记录

Vercel 输出使用 Build Output API，并保留官方 Workflow 生成的队列入口和函数配置。
frontend、API 和 Eve 输出必须绑定同一源码版本；仅有编译成功或 READY 状态不能
证明外部服务、队列投递或业务验收通过。

Vercel TLS 终止后的 origin 由服务端配置的应用域名和平台 deployment host 精确选取；不能信任任意 Forwarded/Host 来扩大认证 origin。Docker 与 Vercel 的 ingress 适配分别验收，普通 Web RPC 的同源校验保持独立。

公司现有项目设置、身份交付、上传操作和生产切换记录见[私有运维入口](README.md)。
通用 Eve 输出与独立 World 的要求见 [Bot runtime](eve-runtime.md)。

## 回滚操作

自托管升级或回退需要同时保留应用、Agent、持久会话和数据库的兼容性。
不能通过删除数据、清空迁移账本或把未完成 Workflow 重定向到另一版本来回退。
公司发布与后端回滚步骤见[私有运维入口](README.md)。

桌面 renderer 的现成回退开关为 `MIKKA_DESKTOP_RENDERER=hosted`。在 macOS 上先完全退出 Mikka，再直接启动应用包内的可执行文件，使进程实际继承该变量（安装位置不同时相应调整路径）：

```sh
env MIKKA_DESKTOP_RENDERER=hosted /Applications/Mikka.app/Contents/MacOS/Mikka
```

恢复默认 bundled 时，再次完全退出应用后运行：

```sh
env -u MIKKA_DESKTOP_RENDERER /Applications/Mikka.app/Contents/MacOS/Mikka
```

按 Owner 指定目标执行后端回滚时，可配合此开关切回 hosted renderer；开关本身不回滚后端或数据库。参见 [桌面 README](../../apps/desktop/README.md#transition-and-rollback)。

回退前确认目标版本支持现有 schema 和队列合同；不能证明兼容时，先修复兼容性。
桌面 renderer 开关只切换客户端呈现方式，不回退服务端或数据库。

## 验收与证据边界

源码路由清单、合同测试、隔离 HTTP 请求、编译入口测试与实际部署请求分别记录。
构建成功不代表 OAuth、模型供应商或正式桌面签名发布通过；数据库结果 JSON 大小
也不等于 PostgreSQL wire 字节。

公开功能验收使用[本地运行环境](../local-runtime.md)和[验收规则](../acceptance.md)。
公司生产验证账号、固定部署记录与各次结果见[私有运维入口](README.md)。

## 显式已部署目标入口

公司已部署目标验证、账号和来源绑定的操作步骤见[私有运维入口](README.md)。
对任何环境，实际驱动源码、被测应用源码与具体部署身份都应分别记录；同一源码
可以有多个部署，不能仅凭应用版本号认定两次运行使用同一部署。

## 文档更新的发布影响

文档的 CI 分类与发布触发条件是不同合同。具体触发条件以当前 workflow 为准，
公司发布观察流程见[私有运维入口](README.md)。移动运维文档不改变现有构建、
队列、签名、迁移或发布门禁。

### Cloudflare Node 24 API image

Build the shared API as `NITRO_PRESET=node-server` with the official frontend output from the same release. Set `MIKKA_BUILD_REVISION`, `MIKKA_UI_OVERLAY_SHA` and `MIKKA_DEPLOYMENT_ID` in that build. Package only the completed API output using a named Docker build context.

```sh
docker buildx build --platform linux/amd64 \
  --build-context release=.output \
  --build-arg MIKKA_BUILD_REVISION --build-arg MIKKA_UI_OVERLAY_SHA \
  --build-arg MIKKA_DEPLOYMENT_ID -f cloudflare/api/Dockerfile cloudflare/api
```

The image verifies all three identifiers while building. At startup the unprivileged Node process requires the cloud edition, the existing application and workspace PostgreSQL connections, the canonical HTTPS application origin, its authentication secret, a separate HTTPS Eve origin and an explicit hosted Workflow target. Supply runtime configuration through the approved private deployment identity. The image starts the existing Nitro listener once. The release owns database migrations. The separate Eve service owns agent sessions and their lifetime. The existing `/mikka/api/health` endpoint tests process liveness, and `/mikka/api/version` reports the compiled release. The Web release Worker owns frontend assets for this target.


Install the locked ingress dependency with `npm ci --ignore-scripts --prefix cloudflare/api/ingress`. Generate the private staging Worker configuration with `node cloudflare/api/ingress/config.mjs <output.json> <deployment-id> <private-image@sha256:digest> <canonical-https-origin>`. Each release names one shared API host. Staging caps this host at one basic container, with a five-minute idle interval. The Cloudflare Container library protects active HTTP bodies and WebSocket connections; individual Task settlement never stops the host. The public release Worker calls this service through its private binding. The ingress rewrites forwarding headers and target port before applying the existing Node authority policy.

Set the scoped app bindings on that release through the approved private pipeline. Only the bindings named in the ingress are passed to the Node process. Identity provisioning, external Workflow support, production instance sizing and the authenticated release checks are required before promotion.
