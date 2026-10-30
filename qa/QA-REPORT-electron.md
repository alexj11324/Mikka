# Mikka 桌面端（Electron）交互 QA 报告 — 2026-10-30

范围：Electron 壳（`apps/desktop`）里的主要页面逐个点击，并逐项验证桌面专属能力。浏览器端由另一个会话负责。

## 测试环境

| 项 | 值 |
|---|---|
| 代码 | `9ea9871d3cb67a4117219707c7de13853334331c`（integration/overnight-1030，draft PR #476，含 PR #431 desktop bug bash） |
| 对比基线 | main `68054f85` |
| Electron | 45.1.0（Chromium 156.0.8078.49），dev flavor，未打包（`app.isPackaged=false`） |
| 壳构建 | `MIKKA_DESKTOP_APP_URL=http://localhost:3100/mikka MIKKA_DESKTOP_FLAVOR=dev pnpm --filter @mikka/desktop build`；`pnpm --filter @mikka/desktop test` 20/20 通过 |
| Web | `next build`（生产构建，构建通过）+ `next start --port 3100`；smoke 按 CI 方式用 `next dev --turbopack --port 3000` |
| 数据库 | 本机 PostgreSQL 16，`mikka_e2e`，角色 `e2e`，`pnpm migrate` + `pnpm test:e2e:setup` |
| 显示 | Xvfb（`xvfb-run -a -s '-screen 0 1600x1100x24'`），窗口 1440×960，Linux，`data-desktop-platform=linux` |
| 语言 | `--lang=zh-CN`，`app.getLocale()=zh-CN`，页面 `lang=zh-CN` |
| 运行用户 | 非 root 用户 `qa`。容器默认是 root，Chromium 以 root 运行时不带 `--no-sandbox` 会直接退出，所以这里用普通用户跑，保留沙箱（`app.enableSandbox()` 仍生效） |
| 账号 | 1 个 owner：在 Electron 窗口里走正常邮箱注册（`qa-electron-<时间戳>@example.com`）。没用共享账号池：`scripts/test-accounts/bootstrap.mjs` 只认 GitHub Actions 运行器（报 `OWNED_GITHUB_SERVICE_REQUIRED`），云容器里写不出 environment 描述文件，这是 adapter 的能力缺口，安全检查未改动 |
| 本机 daemon | `mikka daemon login --dev`（设备授权码 → /device 页“允许”）+ `mikka daemon --dev --data-dir <Electron userData>`，已注册、`server=online` |
| OAuth | Google/GitHub 用合成 client id 让按钮显示出来；没有连接任何真实提供方。`shell.openExternal` 在主进程里被替换成记录函数，“系统浏览器”用另一个 Chromium 模拟 |
| 时间 | 2026-10-30 12:45–13:45 UTC |
| CI | 未查询该提交关联的 CI 运行 |

环境噪音（不算问题）：dbus 和 dconf 警告、IPv6 socket 报错、经代理访问外网时 SSL `-202`（容器 MITM 证书 Electron 不信任）、`/api/skills/search` 503（`skills_oidc_unavailable`，本地没有 Vercel OIDC）、注册时 Better Auth “Email service unavailable”（测试环境关闭了邮件）。

## smoke.mjs 结果

`xvfb-run -a node apps/desktop/test/smoke.mjs`（壳指向 `localhost:3000`，`next dev`）：**SMOKE OK**，退出码 0。

```
bridge {"runtime":"electron","version":"0.1.2","flavor":"dev",...,"requireType":"undefined","processType":"undefined","hasAuth":"undefined",...}
device {"status":"offline",...}            ← 这次没有起 daemon
legacy /devices redirected to …/settings?section=devices
settings devices page rendered
SMOKE OK
```

带 daemon 的 `MIKKA_SMOKE_EXPECT_LOCAL` 条件另外单独验证过（见桌面专属第 9 项）：`device.status()` 返回 `online` 并带 deviceId，设置 › 设备页显示“本机 · 在线”。截图：`shots-electron/09-settings-devices-local.png`。

## 总览

爬虫逐页枚举 button/link/switch/checkbox/combobox/tab/menuitem/textbox，最多点 35–45 个，菜单和对话框打开后按 Esc 关闭，开关切换后再切回。下表是**人工复核后**的结论：爬虫报的 click 超时和“没反应”都逐项复核过，绝大多数是爬虫自身造成的（见表下说明）。

| 页面 | 元素 | 实际操作 | ✅ | ⚠️ | ❌ | 未点（破坏性/外部） | 禁用 |
|---|---|---|---|---|---|---|---|
| 主页（Coordinator） | 26 | 20 | 20 | 0 | 0 | 1 | 3 |
| 建议 | 16 | 12 | 12 | 0 | 0 | 2 | 2 |
| 看板 / 项目 | 24 | 14 | 13 | 1（刷新后回到主页） | 0 | 2 | 3 |
| 插件 / 技能 | 32 | 14 | 14（技能 503 是环境原因，错误态正常） | 0 | 0 | 8 | 2 |
| 产物 | 19 | 12 | 12（没有产物，无法验证筛选效果） | 0 | 0 | 0 | 3 |
| 设置-账户 | 26 | 21 | 21 | 0 | 0 | 4 | 1 |
| 设置-安全 | 24 | 20 | 20 | 0 | 0 | 3 | 0 |
| 设置-偏好设置 | 27 | 24 | 24 | 0 | 0 | 2 | 1 |
| 设置-通知 | 27 | 25 | 25 | 0 | 0 | 2 | 0 |
| 设置-记忆与建议 | 21 | 18 | 18 | 0 | 0 | 3 | 0 |
| 设置-连接 | 36 | 8 | 8 | 0 | 0 | 8 | 3 |
| 设置-模型与额度 | 20 | 18 | 18 | 0 | 0 | 2 | 0 |
| 设置-登录与密钥 | 21 | 19 | 19 | 0 | 0 | 2 | 0 |
| 设置-数据与隐私 | 22 | 18 | 18 | 0 | 0 | 3 | 1 |
| 设置-活动 | 23 | 21 | 21 | 0 | 0 | 2 | 0 |
| 设置-设备 | 22 | 19 | 19 | 0 | 0 | 3 | 0 |
| 设置-常规 | 22 | 20 | 20（名称和 ID 设计上只读） | 0 | 0 | 2 | 0 |
| 设置-团队权限 | 20 | 18 | 18 | 0 | 0 | 2 | 0 |
| 设置-成员 | 26 | 21 | 21 | 0 | 0 | 4 | 0 |
| 设置-团队 | 25 | 21 | 21 | 0 | 0 | 3 | 0 |
| /dashboard（跳转到主页） | 26 | 22 | 22 | 0 | 0 | 0 | 2 |
| /device | 3 | 2 | 2 | 0 | 0 | 0 | 1 |
| /workspaces/new | 5 | 4 | 4（地区是只读选择器） | 0 | 0 | 0 | 1 |

所有页面合计：0 个 pageerror；渲染进程 `console.error` 只有技能页那一条 503；`>=500` 的响应只有 `/api/skills/search`（环境原因）。主进程日志里除了环境噪音，只有 `openExternal` 拒绝非法 URL 时的预期报错。

爬虫误报说明（已逐个复核为 ✅）：
- 主页和 /dashboard 上 7–8 个 click 超时：爬虫点了右上角 🌐 打开了内置浏览器栏，左侧 Bot 列表因此收起，排在后面的目标都变成不可见。关掉浏览器栏后，Coordinator、侧栏收起、概览/全部线程、搜索、加宽右栏（360→520px）、关闭右栏都正常。
- 浅色/深色/跟随系统、通知时机、活动筛选这些按钮被标成“没反应”，其实它们只改 `aria-pressed` 和 `<html>` 的 class，爬虫的变化检测没覆盖这类改动。人工确认深色模式背景确实变了，选中态也正确。
- “Toggle Sidebar”：在设置页能把侧栏从 256px 收到 0。
- “添加文件”：会触发系统文件选择器（`filechooser`，可多选）。
- “筛选项目状态”：是原生 `<select>`，弹出的是系统菜单，不在 DOM 里。
- 爬虫点了偏好设置里的“English”，后面几页因此是英文显示，属于正常的语言切换；之后已切回简体中文。

## ❌ 报错清单

### ❌-1 离线页不会自动重连，界面却一直显示“正在自动重试…”

| 项 | 内容 |
|---|---|
| 页面 | 启动或刷新时服务器连不上 → 壳加载的 `offline.html` |
| 操作 | 把 web 服务停掉 → 刷新（菜单 Reload / Ctrl+R）→ 等 45 秒 → 重新启动服务 → 再等 45 秒 |
| 现象 | 页面显示“暂时连不上 Mikka / 请检查网络连接，Mikka 会自动重新连接。/ 已离线 N 秒，正在自动重试…”，秒数一直往上跳，但**从没有发出过重连请求**。服务恢复后窗口也一直停在离线页，只有手动点“立即重试”或按 Ctrl+R 才能回到应用（这两条路径都验证过可以恢复） |
| 证据 | 主进程导航事件跟踪（`qa/electron-check-offline-trace.json`）：`1.1s start app → 1.1s fail -102 ERR_CONNECTION_REFUSED → 1.1s start offline.html → 1.1s finish http://localhost:3100/mikka → 1.2s finish offline.html`，之后 90 秒里没有任何 `start`。服务恢复后点击“立即重试”，`18.1s start app → 19.5s finish app` |
| 截图 | `shots-electron/01-offline-page-stuck.png`、`02-offline-retry-click-recovers.png` |
| 原因 | `apps/desktop/src/main/index.ts:224-230`。Chromium 在 `did-fail-load` 之后，还会为失败地址的错误页触发一次 `did-finish-load`，这时 `getURL()` 仍然是应用地址。处理函数把这次当成“应用加载成功”，执行了 `clearTimeout(retrying)`，把 `showOffline()`（`index.ts:171-179`）刚设好的 2 秒重试定时器清掉了，而且 `offlineAttempt` 也被归零 |
| main 上是否也有 | **有**。main 的 `index.ts:189-197` 是同样的模式：`retryLater()` 设定时器，随后 `did-finish-load` 把它清掉。PR #431 加了退避和倒计时文案，但没修这个时序 |
| 建议修法 | 只有真正加载成功才清定时器：比如记录最近一次 `did-fail-load` 的 URL，在 `did-finish-load` 里跳过这次；或改用 `did-navigate` 并检查 `httpResponseCode`。并补一个主进程单测或 smoke 用例：停服务 → 离线页 → 起服务 → 应用自动回来 |
| 严重程度 | 中高。发生概率 6（开机后网络还没就绪、休眠唤醒、服务重新部署都会遇到）× 影响 6（窗口卡在离线页，提示文字还在误导用户）。可以手动恢复，没有数据风险 |

## ⚠️ 清单

| # | 位置 | 现象 | 原因 file:line | main 上是否也有 | 建议 |
|---|---|---|---|---|---|
| ⚠️-1 | 看板 | 点图标栏“看板”后地址变成 `/mikka`（没有 `section`）。按 Ctrl+R 或菜单 Reload 后回到“主页”，不是看板（`03-board-reload-lands-home.png`）。桌面端没有地址栏，刷新是常用操作，所以更容易碰到 | `components/workspace/issue-workspace.tsx:172`（`all-issues` 等分区会删掉 `section`），`app/[locale]/page.tsx:23`（`initialSection` 不认看板） | 有（main `issue-workspace.tsx:160`） | 给看板分区写入 `section`，并让 `page.tsx` 认这个值 |
| ⚠️-2 | 系统浏览器里的 loopback 回跳页 | 中文用户在浏览器里看到的是英文 “Returning to Mikka…”；失败时显示 “This sign-in link is invalid or expired. Return to Mikka and try again.”（`04-loopback-page-english.png`） | `apps/desktop/src/main/loopback.ts:36,41` 写死了英文 | 没有（`loopback.ts` 是 PR #431 新增的） | 按 Accept-Language 或系统 locale 出中文。按 R-40，成功页只留“正在返回 Mikka…”这一句状态 |
| ⚠️-3 | 应用内 `http://` 外链 | 指向非 TLS 外站的链接（`target=_blank` 或直接导航）在桌面端被静默拒绝：不打开，也没有提示。浏览器里会正常打开。https 链接正常（例：技能页“打开 skills.sh”→ 系统浏览器，窗口不动） | `apps/desktop/src/main/security.ts:46`（`externalUrl` 只放行 https 和 mailto） | 有（main 同一行） | 如果是刻意的安全策略，至少要给用户一个提示；也可以考虑放行 http，交给系统浏览器打开 |
| ⚠️-4 | 设置页侧栏收起按钮 | 中文界面下读屏名是英文 “Toggle Sidebar” | `components/settings/settings-sidebar.tsx:86` `<SidebarRail />` 没传 `label`（组件库 `components/ui/sidebar.tsx:295` 默认值是英文） | 有（main `settings-sidebar.tsx:96`） | 传一个翻译过的 `label` |

## 桌面专属功能逐项结果

| # | 项 | 结果 | 细节 |
|---|---|---|---|
| 1 | 渲染进程隔离 | ✅ | `contextIsolation=true, sandbox=true, nodeIntegration=false, nodeIntegrationInSubFrames=false, webviewTag=false, webSecurity=true`。`window.require / process / module / Buffer / ipcRenderer / electron` 都是 `undefined`；改写 `mikka.app.runtime` 不生效；同源 iframe 里没有 `window.mikka` |
| 2 | preload 桥与平台检测 | ✅ | `window.mikka` 只有 `app / notifications / device / quota` 四个接口，没有 `auth / settings`；`runtime=electron, flavor=dev, version=0.1.2`；`<html data-desktop-platform="linux">` |
| 3 | `openExternal` 白名单 | ✅ | 只接受同源 http(s)；`https://example.com`、`file://`、`javascript:`、`http://evil.example` 都被拒绝，主进程抛 “openExternal accepts only app-origin HTTP(S) URLs” |
| 4 | 外链不在应用窗口里打开 | ✅（http 见 ⚠️-3） | `window.open('https://…')` 返回 null，交给系统浏览器；`location.href='https://…'` 被拦住，窗口地址不变；同源 `window.open` 开一个子窗口（同样隔离，带桥）；真实 UI 链接“打开 skills.sh”→ 系统浏览器 |
| 5 | 登录：桌面 OAuth 交接（loopback） | ✅ 全流程跑通（真实 Google/GitHub 未测） | Electron 里点“使用 Google 继续”→ 窗口不跳转，出现提示“已在浏览器中打开登录页；完成后会自动返回 Mikka。”→ 系统浏览器收到 `…/sign-in?desktop=1&desktop_state=…&desktop_callback=http://127.0.0.1:<port>/auth/callback` → 在“浏览器”里用邮箱登录 → `/api/desktop/return` 303 跳到 loopback → Electron 加载 `/api/desktop/finish` → exchange → one-time-token → Electron 拿到同一账号的会话（`sameAccount=true`）。截图 `05`–`07` |
| 6 | `prepareAuth` 和 loopback 校验 | ✅ | 太短或带非法字符的 nonce 被拒；合法 nonce 返回 `http://127.0.0.1:<随机端口>/auth/callback`；错误路径返回 404；state 不符返回 400，监听随即关闭 |
| 7 | 邮箱注册 / 登录 / 退出 | ✅ | 在 Electron 里注册后直接进入工作台；图标栏头像菜单 → “退出登录”→ `/sign-in?login=1` |
| 8 | 图标栏和窗口外壳 | ✅（⚠️-1 除外） | 主页/建议/看板/插件/产物 文字完整、不溢出，`aria-current` 正确；窗口顶栏的 ←/→ 和全局搜索可用；Linux 上没有拖拽区（只有 darwin 才加，符合设计）；最小尺寸 900×600；Linux 菜单栏隐藏 |
| 9 | 头像 | ✅ | 图标栏底部工作区按钮显示首字母头像 “Q”（36×36，`aria-label="工作区菜单"`），菜单项：设置 / 切换工作区 / 退出登录 |
| 10 | daemon 调用和“本机” | ✅ | `device.status()` → `online, deviceId, signedIn=true`；`quota.get()` → 3 个供应商（unknown）；设置 › 设备显示“本机 · 在线”。首次读取时 `server` 字段短暂显示过 `offline`，随后 `daemon status` 显示 `online` |
| 11 | 原生通知和角标 | ✅ IPC 和校验 / ⚠️ 本环境无法展示 | 合法 payload 被接受；`href` 指向外站会被 zod 拒绝；角标只接受非负整数（-1、1.5、'x'、100000 被拒，3 成功写入）；主进程发 `notifications:clicked('/')` 后渲染进程跳回主页。本容器没有 dbus，`Notification.isSupported()=false`，看不到真实弹窗 |
| 12 | 缩放快捷键 | ✅ | Ctrl+= 放大到 0.5 级，Ctrl+0 复位；缩放按 host 记住，下次启动沿用（Chromium 默认行为）；放大后布局完整 |
| 13 | 单实例 | ✅ | 再启动一个同 profile 的进程，0.4 秒内退出，原窗口仍在 |
| 14 | 离线页 | ❌（见 ❌-1） | 页面和文案正常，“立即重试”能恢复，自动重连坏了 |
| 15 | 深链 / 自定义协议 | 不适用 | 没有注册 `mikka://`（`isDefaultProtocolClient('mikka')=false`），设计上用 loopback 代替 |
| 16 | 自动更新 | 未测 | 只有打包后的应用才会检查更新；dev 构建里没有“检查更新”菜单 |
| 17 | 请求头 | 未直接验证 | 代码 `index.ts:103-113` 会给应用源请求加 `x-mikka-client: desktop` 和版本号；本次只确认请求经过这个钩子后仍正常返回 200，没有抓包看请求头 |

## 和浏览器表现不同的地方

- Google/GitHub 登录：桌面端不在窗口里打开提供方页面，而是交给系统浏览器，再通过 loopback 回到应用；浏览器端是直接跳转。
- 外链：https 和 mailto 交给系统浏览器，非 TLS 的 http 外链被静默忽略（⚠️-3）；浏览器会开新标签页。
- 同源 `target=_blank`：桌面端开一个隔离的子窗口；浏览器开新标签页。
- 连不上服务器时：桌面端显示自带的离线页（并且会卡住，❌-1）；浏览器显示原生错误页，用户自己刷新。
- 原生通知、Dock/任务栏角标、本机 daemon 状态只在桌面端有；Web 端 `DesktopIntegration` 什么都不渲染。
- 刷新（Ctrl+R）在桌面端没有地址栏可以对照，看板刷新后回到主页的问题（⚠️-1）在桌面端更明显。

## 未测 / 跳过与原因

- 未点（破坏性/外部）：删除账户、退出登录（只在认证环节专门测了一次）、新建 Bot/项目/团队、邀请成员、连接 Google/GitHub/Linear/Telegram/Slack/Composio 和各个“连接/授权”按钮、Gmail/日历/Slack 插件入口、刷新建议、保存类表单提交、发送消息（会调用模型）。
- 真实 Google/GitHub OAuth：没有连接提供方，只验证了桌面交接链路（用邮箱登录代替提供方那一步）。
- 原生通知弹窗、角标的视觉效果：容器里没有 dbus 和通知守护进程。
- macOS 专属表现（红绿灯、拖拽区、`titleBarStyle`）和 Windows：只在 Linux 上测过。
- 自动更新：需要打包、签名后的应用。
- 共享测试账号池（`scripts/test-accounts/session.mjs`）：bootstrap 只能在 GitHub Actions 上跑，这里改用应用正常的邮箱注册。
- 内置浏览器栏加载外站：本容器访问外网要过 MITM 代理，Electron 不信任它的证书，只确认了 iframe 的 `src` 设置正确。

## 原始数据

- `qa/electron-crawl-raw.json`：每页每个元素的爬虫结果（复核前）
- `qa/electron-check-daemon.json`：daemon、本机、看板刷新、缩放、单实例
- `qa/electron-check-offline-trace.json`：离线重连的主进程导航跟踪
- `qa/electron-scripts/`：本次用的 Playwright `_electron` 脚本（以非 root 用户在 Xvfb 下运行；`lib.mjs` 里把 `shell.openExternal` 换成了记录函数）
