# Web 与桌面共享运行时

本文说明Issue #1415共享运行时的运行、构建与回退约定。当前目标是正常功能CI、生产功能验证和正式桌面release。性能实测及其门槛、一小时idle、旧首页对照和Dev ZIP交付已取消；polling-policy、idle-budget等功能合同检查继续保留。各轮发布、失败与验收的精确来源见 [验收报告](../acceptance/issue-1415/final-report.md) 和 [完整证据](../acceptance/issue-1415/final-evidence.md)。正式桌面504已满足一次性交付要求。2026-11-07 01:28:30 UTC，固定APP354f/Dg的完整四段生产验收及清理已通过；此文档自身的正常PR/CI/合并/Web发布和最后资源停止，由Issue收口评论另行记录。

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

每个 Node/Vercel 入口先静态载入 `mikka-tracing.mjs`，再动态载入应用图，保证 tracing 初始化早于实际 `pg` 导入；仅靠较晚的 Nitro 插件不满足这个顺序。`pg` 和 OTel 使用真实外部依赖及其 package 元数据。请求 span 按实际响应结束收尾，后台 `after` 工作保留捕获的上下文。真实 HTTP → SQL → 后台任务 trace、流断开和导出结果仍须在固定环境单独验收，不能由 bundle 文件存在推断通过。 已保留的7ed链路样本使用默认0.1 sampler，并预先选择该采样器接受的traceID；它只证明一条真实API→DB→本地OTLP导出链路，不测采样率，也不证明生产供应商入库。

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

## Vercel 构建与生产切换记录

当前 [`web-deploy.yml`](../../.github/workflows/web-deploy.yml) 保留 GitHub runner 上构建并上传 prebuilt 的流程，`vercel.json` 设置 `framework: null`，Git 自动部署关闭。发布从固定 main 提交开始，读既有 Infisical workload identity，拉取现有 production 项目配置；不新建身份或改生产数据位置。

[`build-vercel.mjs`](../../scripts/release/build-vercel.mjs) 要求 Node 24、锁定 pnpm、源 SHA 与 CI SHA 一致；给 frontend/API 设置相同应用 build，选择每次 run attempt 唯一的 deployment ID，清除测试环境标记，再执行完整 `pnpm build`。上传前再次拒绝过时 main；通过 `deploy --prebuilt --prod` 上传后，现有 verify 步骤检查公开域名版本。仅有 READY 状态不足以完成业务验收。

生产环境文件的值采用JSON字符串编码，builder直接使用发布helper已经解析、补值和校验的对象，不能再交给另一种dotenv解码器。环境选择保留旧CLI的合同：非空job值优先，空或缺失才使用文件值；生产、仓库、源提交与deployment身份仍显式固定。完整构建前用原`directDatabaseURL`纯校验两个最终目标，不改写连接串。两类已修复问题的实际诊断和失败尝试见[验收报告](../acceptance/issue-1415/final-report.md#两次受阻的生产发布与已确认的环境根因)，不在运维步骤中重复发布时间线。

以下步骤保留 Issue #1415 的一次性生产切换流程和 Owner 当时指定的目标。
迁移已经完成。日常发布按 [Web 部署指南](web-deploy.md) 和当前 workflow 执行。
Web 与 Mac 可并行构建，桌面发布继续核验来源/后代关系和 overlay 绑定。

1. 固定准备合并的完整commit，完成其功能CI与完整清理；记录PR head、实际checkout/tree和run/job。保留各历史版本证据的范围，不新增已取消的性能或Dev ZIP门槛。
2. 切换前刷新上一READY生产部署、可回滚状态、Vercel项目framework/build配置、队列入口及未完成run的部署归属；核对主线迁移的向后兼容性。Owner指定的操作回滚目标是 `dpl_A2gvRemMPjimhZTKYY4Rw4SsgLUN`，操作前再次核验其 READY 状态；当时最新部署只是切换前快照，不能擅自代换 Owner 目标。
3. **先把Vercel项目framework设为Other/null，再立即正常合并已通过的PR。** 这样main的Web deploy首次pull到正确配置；仅仓库vercel.json为null不能证明远端项目已修改。
4. 由原串行Web发布流程执行固定main的完整构建、迁移、prebuilt上传和公开version核验。保存实际deployment及产物配置；历史7ed的本机产物检查不冒充本次Vercel上线。
5. 用正常owner权限核验生产浏览器、任务/托管Workflow及到期timer、mobile/来源daemon HTTP、OAuth/MCP；记录精确应用SHA与正常资源清理。没有成功的实际回执就保持pending。
6. 按当前桌面workflow，main preflight先执行专用await-desktop-web并绑定生产overlay；Mac随后完成构建、Developer ID签名、公证、staple、生产fuses、updater与seal。发布前在同一macos job再次核精确来源CI、await-desktop-web和封存候选/hosted证据，最后正常发布；第二次检查不能省略。Web可并行前进，但必须满足同源或后代关系及overlay绑定。CI的ad-hoc验收包不是正式release。
7. 最后确认任务临时资源和安全证据去向，不保留为了已取消验收而运行的机器。

Vercel TLS 终止后的 origin 由服务端配置的应用域名和平台 deployment host 精确选取；不能信任任意 Forwarded/Host 来扩大认证 origin。Docker 与 Vercel 的 ingress 适配分别验收，普通 Web RPC 的同源校验保持独立。

## 回滚操作

Issue #1415 切换时，Owner 指定的操作回滚目标为 **`dpl_A2gvRemMPjimhZTKYY4Rw4SsgLUN`**，来源 `184a375f`，2026-11-06 22:54:07 UTC 已核 READY。该记录属于当次切换。后续事故需要核对本次已验收目标、现有部署状态和迁移兼容性，再按 Owner 的当前授权回滚。`dpl_63kkAf86gNLuztV169tXfDH5qw4h` / main `62281b19` 是切换前正在服务的快照，不是可以擅自替换的回滚目标。

回滚单位是上一完整已验收版本及对应运行配置。仓库回滚通过 **revert PR**；不 force-push main、不删 deployment、不改 Neon、不撤销共享凭据，也不运行破坏性的 down migration。

桌面 renderer 的现成回退开关为 `MIKKA_DESKTOP_RENDERER=hosted`。在 macOS 上先完全退出 Mikka，再直接启动应用包内的可执行文件，使进程实际继承该变量（安装位置不同时相应调整路径）：

```sh
env MIKKA_DESKTOP_RENDERER=hosted /Applications/Mikka.app/Contents/MacOS/Mikka
```

恢复默认 bundled 时，再次完全退出应用后运行：

```sh
env -u MIKKA_DESKTOP_RENDERER /Applications/Mikka.app/Contents/MacOS/Mikka
```

按 Owner 指定目标执行后端回滚时，可配合此开关切回 hosted renderer；开关本身不回滚后端或数据库。参见 [桌面 README](../../apps/desktop/README.md#transition-and-rollback)。

在记录的迁移merge commit已核对、且没有需要保留的后续依赖变更时，先创建 `/tmp/runtime-rollback.md`，写明事故、原版本/目标版本、迁移兼容性、项目配置恢复和验证计划，不含秘密；随后执行：

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

若迁移跨多个合并提交，先明确依赖与按逆序需要 revert 的提交，不能只回退一个目录。CI 根据实际回滚版本运行；合并 revert PR 后由恢复的发布链重建、执行原迁移 guard 并部署。

Vercel 项目设置不由 `git revert` 自动回滚。按切换前留存的配置恢复原 Next.js framework/build 配置及对应官方 Workflow 队列入口，核对旧部署未完成 run 仍能继续；不要猜测项目值或另建队列。恢复后确认公开应用版本、登录、workspace 权限、关键读写、流/回调、Workflow 和 trace。若已有 schema 变化不兼容旧代码，保留现有数据并先修复兼容性，不能用恢复数据库来代替源码回滚。

## 验收与证据边界

生产验证必须记录真实驱动、实际部署应用、公开版本和正常owner身份。原自动验收及普通Web发布继续使用原current-main门禁；桌面发布按已合入的来源/后代关系与overlay合同执行。本次独立手动入口使用下面的显式已部署目标合同，不伪造或重写旧run的事件来源。部署READY、公开匿名HTTP通过、ad-hoc原生功能包和正式Developer ID发布是不同证据；任何一次成功不能改写其他来源的失败或skip。各次验证的时间、状态与回执入口统一放在[验收报告](../acceptance/issue-1415/final-report.md)，完整字段和历史哈希放在[final-evidence.md](../acceptance/issue-1415/final-evidence.md)。

路由源码清单、合同测试、隔离HTTPS请求、编译入口的进程内Request/Response及真实生产请求分别记录，不把其中一种扩称为全部公开HTTP路径已实测。tracing近似DB字节与PG协议wire字节也不能相加或互换；默认0.1采样器下预选其接受的traceID，仅证明该条真实导出链路，不测采样率，也不证明供应商入库。

截图从GitHub实际run/artifact页面访问，受正常权限与保留期限制；不使用停止的Docker服务链接，也不声称未执行的90天上传已留存。正常release应核对manifest列出的文件及manifest自身：504有7个清单文件加manifest共8个资产，manifest自身的SHA由seal输出提供，不通过自包含manifest证明自己。504已满足本Issue一次性正常桌面发布要求；后续release不新增为关闭门槛，CI、签名、公证与封存条件保持；桌面专用await-desktop-web按已合入的来源/祖先规则等待，普通await-web仍严格。现有SBOM只覆盖desktop runtime依赖图，不声称完整包含共享UI。

保留所有原鉴权、精确来源、采样和清理门禁；未通过时按原结果记录。私密账号、环境descriptor、凭据及原始OTLP不进入公开材料。相关操作见[部署](web-deploy.md)、[tracing](tracing.md)、[本地循环](../local-runtime.md)和[验收规则](../acceptance.md)。

## 显式已部署目标入口

正常 [PR1520](https://github.com/alexj11324/Mikka/pull/1520) 新增独立main `workflow_dispatch` 入口，真实inputs为 `application_sha`、`web_run_id`、`deployment_id`。真实driver的 `GITHUB_SHA`、run、attempt与被测APP分开记录；不能改写这些GitHub身份来复用旧事件，也不能把source相同但deployment不同的发布混为同一个目标。

在读取owner凭据前，共享attestor验证真实driver事件、指定成功Web来源、固定project/team、READY deployment、当前生产alias与公开版本。各段业务前后以及最终汇总重新验证同一目标；目标变化不能通过，正常会话与资源清理仍须执行。历史APP2960先后有两个正常同SHA部署，第一轮因旧deployment被替换而在凭据前拒绝，说明deployment绑定并非多余条件。

业务顺序为浏览器→Coordinator与到期timer→mobile/source-daemon→OAuth/MCP。仅显式deployed模式关闭截图、trace、video并设置零重试；原UI断言和默认业务合同保持。只有四段真实成功、各自正常清理、共同target/driver/team绑定以及最终现场核验齐全，才能声明全流程通过。2026-11-07的实际run42323706132已在APP354f/Dg上完成四段及最终现场核验，全部要求的清理成立。源码daemon仅验证正常HTTP/protocol3，不是OS安装；MCP仅正常会话、PKCE、initialize与25项目录，0tools/call/0model，非团队数据工具或OS listener验收。Managed保留timerTerminalRequired/concurrentReconciliationExcluded为false，sessionClosed依据sign-out响应。旧8180未知locator的浏览器失败和全部历史结果继续保留；具体身份、原始报告与限制见[验收报告](../acceptance/issue-1415/final-report.md)。

按 [AGENTS f363](https://github.com/alexj11324/Mikka/blob/f3635e534b2de87d354e3c53c28542782588f609/AGENTS.md) 和 [Owner指定身份的评论](https://github.com/alexj11324/Mikka/issues/1504#issuecomment-6691409495)，后续完整验收使用已有共享SMOKE账号，在Alex团队工作区通过正常成员权限执行，不登录Alex本人。#1555的helper读取每个有界team候选，以可信身份哈希匹配唯一active admin且非SMOKE，随后正常switch并无query回读；共享账号可以是member。四段报告必须含相同team hash、`teamAdminMembershipVerified:true`以及固定basis/attribution，不输出成员邮箱、ID或token。MCP仅证owner-session，catalogue不代表团队数据访问证明。历史 `personalWorkspaceConfirmed` 保留原义，不能重标成团队通过。

[Owner在#1515的单次授权](https://github.com/alexj11324/Mikka/issues/1515#issuecomment-6694934529) 所需前提设置已通过正常接口完成：共享SMOKE已加入既有 **Acme Inc.**，Claude和Codex两个已有订阅来源对它可见，双方会话已正常退出。该次自有API key为0，未执行key分享请求或模型prompt。此例外不扩大普通验收权限，后续仍仅使用SMOKE；验收在Acme Inc.中执行，见 [验收账号约定](../acceptance.md)。该次设置只证明前提完成；后续完整业务通过由独立run42323706132的四份报告、清理和目标核验建立。

Owner要求的桌面后代Web兼容和过期任务取消已通过正常合并落实。桌面专用await-desktop-web接受经过来源与祖先关系核验的同源或后代Web；当前workflow在preflight和发布前两次检查，并保留私有overlay绑定与封存复核。过期候选与正在签名作业的并发策略由当前desktop-release workflow管理；来源、overlay和发布门禁保持独立。普通await-web、strict E2B、CI、签名、公证与seal门禁仍保留。正式504已满足一次性桌面交付，旧临时冻结窗口已结束，不增加“每次外部main前进都必须再出一个桌面版本”的收口条件。

## 文档更新的发布影响

最终十个Markdown/SVG路径的实际静态分类为docs-only，且不匹配桌面release路径；已核8180→74d及74d→f363的比较没有改动这些路径、分类器或发布workflow，后来的README许可、贡献和任务编号内容保持。Web workflow另有独立规则：每次正常main push都设置runtime refresh并要求实际Web build。因此docs-only不等于不构建Web；最终文档须通过正常PR并保留这条发布规则，不修改分类器或发布门禁。后续main若改变相关workflow或README，提交前重新只读核对。完整静态调用、源码hash及历史记录在[完整证据](../acceptance/issue-1415/final-evidence.md)。

### Cloudflare Node 24 API image

Build the shared API as `NITRO_PRESET=node-server` with the official frontend output from the same release. Set `MIKKA_BUILD_REVISION`, `MIKKA_UI_OVERLAY_SHA` and `MIKKA_DEPLOYMENT_ID` in that build. Package only the completed API output using a named Docker build context.

```sh
docker buildx build --platform linux/amd64 \
  --build-context release=.output \
  --build-arg MIKKA_BUILD_REVISION --build-arg MIKKA_UI_OVERLAY_SHA \
  --build-arg MIKKA_DEPLOYMENT_ID -f cloudflare/api/Dockerfile cloudflare/api
```

The image verifies all three identifiers while building. At startup the unprivileged Node process requires the cloud edition, the existing application and workspace PostgreSQL connections, the canonical HTTPS application origin, its authentication secret, a separate HTTPS Eve origin and an explicit hosted Workflow target. Supply runtime configuration through the approved private deployment identity. The image starts the existing Nitro listener once. The release owns database migrations. The separate Eve service owns agent sessions and their lifetime. The existing `/mikka/api/health` endpoint tests process liveness, and `/mikka/api/version` reports the compiled release. The Web release Worker owns frontend assets for this target.
