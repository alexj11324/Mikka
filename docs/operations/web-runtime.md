# Web 与桌面共享运行时

本文按当前源码重新编写，说明 Issue #1415 第二阶段的运行、构建和回滚约定。它不是丢失文档的原文恢复，也不是迁移完成报告。最终验收须绑定同一个提交、构建产物和运行环境，填写文末证据表后才能认定完成；早期构建、第一阶段桌面结果不能替代第二阶段验收。

## 入口与输出

Web 和桌面通过 [`apps/frontend`](../../apps/frontend/vite.config.mjs) 编译同一套现有业务组件。平台适配器处理导航、认证和传输；页面、工作区、聊天和设置继续复用共享组件。生产 Web 的 HTML 入口为 SPA，API 由独立 Hono/Nitro 服务处理。

| 层 | 源入口或配置 | 输出与职责 |
| --- | --- | --- |
| Web 前端 | `apps/frontend/vite.config.mjs`，目标 `web` | `apps/frontend/dist/web`；公开路径 `/mikka/` |
| 桌面前端 | `apps/desktop/scripts/build-renderer.mjs`，目标 `desktop` | `apps/desktop/dist/renderer`；由 Electron 本地协议提供 |
| API | `apps/api/nitro.config.ts`、`apps/api/runtime/entry.ts` | Hono 分派现有业务 handler，Nitro 承担 Node/Vercel 生命周期 |
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

[`generate-routes.mjs`](../../apps/api/scripts/generate-routes.mjs) 通过 TypeScript AST 读取 `app/**/route.ts` 的导出、re-export 与解构 handler，不执行路由模块。当前 [`routes.json`](../../apps/api/generated/routes.json) 为 version 1、basePath `/mikka`，包含 **220 条路由记录**；这是当前源码清单数量，不是 220 条真实 HTTP 验收结论。它记录方法、源文件 hash、动态参数和 `maxDuration`，另有独立 browser RPC 与 OAuth consent 安全投影入口。

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
| `pnpm build:app` | 先构建 Web Vite，再构建 API；默认 `node-server`，不执行完整发布链的最后迁移步骤 |
| `pnpm build` | subscription worker → agent UI 生成 → build:app → 完整 typecheck → **数据库迁移** |
| `pnpm start --hostname 127.0.0.1 --port 3000` | 验证已编译 `.output` 后启动实际 Node 产品；不构建、不迁移 |
| `pnpm --filter @mikka/desktop build` | Electron 主进程/preload 与同图桌面 Vite renderer |

开发入口保留根工作目录用于 Workflow 发现，API proxy 不改请求 origin；页面继续应用同一语言和 HTTP 策略。新增/变更路由会重新生成清单。停止时关闭自己拥有的 Nitro/LocalWorld 和 Vite 连接；无需以反复轮询补偿热更新或业务 live 通知。

[`start-app.mjs`](../../scripts/start-app.mjs) 在导入和监听前检查 `.output/mikka-build.json`、真实 Node 24、preset、revision、锁文件/路由/tracing hash 格式及可选测试 revision 绑定。它保留启动目录；从构建所对应的仓库根目录使用 `pnpm start`。启动时只做有界 `/mikka/api/version` 就绪检查，验证实际 build，随后不新增空闲读取。

发布必须包含完整输出和所需运行依赖，不能只复制 `index.mjs`。finalize 将域名数据、E2B 脚本和已生成的 worker/enrollment 二进制等实际资源复制入 Node 输出或各 Vercel 函数，并记录 hash。独立归档运行还须验证原 `process.cwd()` 资源路径和正式入口；不要绕过启动校验临时拼接部分输出。

Docker 的公开验收入口使用同一次 Nitro 编译图的 `mikka-docker.mjs`；该 adapter 不自行 listen、不安装信号处理器、`trustProxy=false`。外层已核验环境持有 HTTP/WS 监听与 ingress，严格验证固定 origin/Host 后交给真实 Node request；关闭顺序包含响应结束、官方 waitUntil 和 Nitro close。不能用新起的普通 listener 替代这个环境证明。

## Vercel 构建与生产切换顺序

当前 [`web-deploy.yml`](../../.github/workflows/web-deploy.yml) 保留 GitHub runner 上构建并上传 prebuilt 的流程，`vercel.json` 设置 `framework: null`，Git 自动部署关闭。发布从固定 main 提交开始，读既有 Infisical workload identity，拉取现有 production 项目配置；不新建身份或改生产数据位置。

[`build-vercel.mjs`](../../scripts/release/build-vercel.mjs) 要求 Node 24、锁定 pnpm、源 SHA 与 CI SHA 一致；给 frontend/API 设置相同应用 build，选择每次 run attempt 唯一的 deployment ID，清除测试环境标记，再执行完整 `pnpm build`。上传前再次拒绝过时 main；通过 `deploy --prebuilt --prod` 上传后，现有 verify 步骤检查公开域名版本。仅有 READY 状态不足以完成业务验收。

正式切换按以下顺序执行并保留证据：

1. 固定准备合并的完整 commit，完成对应 CI；记录真实 checkout/merge SHA，不能用可移动分支名替代。Web、API、桌面兼容验证及资源清单须能追溯到该提交和同一锁文件。
2. 以该产物在已授权 Medium 隔离环境验证真实 HTTP、Cookie/RPC、PKCE、数据库读取预算、空闲/live、流取消、资源与 Workflow 重启；保存旧/新对照原始样本和清理证明。旧版本 Medium 结果不能给新版本打勾。
3. 在切换前记录上一完整已验收提交、生产 deployment、Vercel 项目 framework/build 配置、SDK 队列路由与未完成 run 的部署归属；确认迁移的向后兼容性及回滚点。
4. 通过 PR 合入固定版本，执行现有串行生产发布流程。核查最终 `.vc-config.json`、Node runtime、队列 triggers、依赖元数据、函数实际大小、静态 pin 与 `mikka-build.json`，不得沿用旧 draft 的产物检查结论。
5. 生产 READY 后核验公开版本和真实账号/任务边界，记录 OAuth/桌面/Workflow/SQL tracing 的实际范围及尚未完成项。完成环境工作后停止临时机器，不保留空闲大机。

Vercel TLS 终止后的 origin 由服务端配置的应用域名和平台 deployment host 精确选取；不能信任任意 Forwarded/Host 来扩大认证 origin。Docker 与 Vercel 的 ingress 适配分别验收，普通 Web RPC 的同源校验保持独立。

## 回滚操作

回滚单位是上一完整已验收版本及对应运行配置。仓库回滚通过 **revert PR**；不 force-push main、不删 deployment、不改 Neon、不撤销共享凭据，也不运行破坏性的 down migration。

在记录的迁移 merge commit 已核对、且没有需要保留的后续依赖变更时：

```sh
git fetch origin
git switch -c revert/shared-web-runtime origin/main
migration_merge='<替换为证据中记录的迁移 PR merge commit>'
git show --no-patch --format=fuller "$migration_merge"
git revert -m 1 "$migration_merge"
pnpm install --frozen-lockfile
git push -u origin revert/shared-web-runtime
gh pr create --title 'Revert shared web runtime migration' --body-file /tmp/runtime-rollback.md
```

`/tmp/runtime-rollback.md` 写明事故、原版本/目标版本、迁移兼容性、项目配置恢复和验证计划，不含秘密。若迁移跨多个合并提交，先明确依赖与按逆序需要 revert 的提交，不能只回退一个目录。CI 根据实际回滚版本运行；合并 revert PR 后由恢复的发布链重建、执行原迁移 guard 并部署。

Vercel 项目设置不由 `git revert` 自动回滚。按切换前留存的配置恢复原 Next.js framework/build 配置及对应官方 Workflow 队列入口，核对旧部署未完成 run 仍能继续；不要猜测项目值或另建队列。恢复后确认公开应用版本、登录、workspace 权限、关键读写、流/回调、Workflow 和 trace。若已有 schema 变化不兼容旧代码，保留现有数据并先修复兼容性，不能用恢复数据库来代替源码回滚。

## 最终证据表（待填）

源码审阅、局部单元测试和曾经完成的 draft 构建只支持各自记录的范围。本表尚未宣告 CI、Medium 或生产通过；填写时附精确版本、原始报告与必要限制。

| 门槛 | 必须保存的证据 | 状态 |
| --- | --- | --- |
| 固定源与 CI | merge/checkout SHA、CI run/job、锁文件 hash、对应测试结果 | 待最终版本 |
| 同图编译与产物 | Web/desktop manifest、API build manifest、deployment ID、资源与归档 digest | 待最终版本 |
| HTTP/身份/语言 | 220 路由覆盖映射、真实方法/stream、Cookie/CSRF、账号切换、PKCE、locale 重入 | 待环境验收 |
| Workflow 与 tracing | 真实重启/恢复、托管队列回调、响应结束/取消、HTTP→SQL→后台 trace | 待环境验收 |
| Medium 性能与清理 | 固定新旧样本、读查询/字节、空闲/live、真实 daemon、资源及 lease 清理 | 待环境验收 |
| 桌面 UI/原生/lifecycle | 同版本截图、真实 OS 能力、冷启动原始样本、离线恢复、一小时空闲 | 待完整验收 |
| 生产与回滚点 | 生产 deployment/公开版本、真实任务、旧配置快照、回滚目标、机器停止记录 | 待生产验证 |

相关入口：[部署操作](web-deploy.md)、[tracing](tracing.md)、[本地完整循环](../local-runtime.md)、[验收规则](../acceptance.md)、[运行时性能证据目录](../acceptance/issue-1415/runtime-performance.md)。
