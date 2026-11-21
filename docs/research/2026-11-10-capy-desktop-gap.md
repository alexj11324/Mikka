# Capy 桌面端 0.7.2 与 Mikka 的差距

日期：2026-11-10。读者是决定下一刀桌面端和本机执行的人。读完可以判断哪些缺口要补、哪些只是对方整站被打进安装包。本文不是决定，不改 `docs/design/decisions/`。

## 看过什么

- 安装包：`https://capy.ai/download/mac/arm64` 跳到 `https://downloads.capy.ai/stable/Capy-0.7.2-arm64.dmg`（163 627 484 字节，S3 `Last-Modified` 2026-11-01 22:00:23 UTC）。`CFBundleIdentifier` `ai.capy.desktop`，`CFBundleShortVersionString` `0.7.2`，版权 Scrapybara, Inc.，最低 macOS 13.0，URL scheme `capy`。
- 工具：REA 6.8.0 的 `analyze-javascript-application`，对象是包内 `Contents/Resources/app.asar`（SHA-256 `5e2d9d27e04a38e1257beb32f7bd6d04749e5f5a826d414aeb0935de669a9450`）。Evidence `ev_56a84ae5ea4206eb2aa955a9e9d982e57f9bc01460f15780f9b2a94df6fcfc00`。图里 6 个 JavaScript 文件全部解析，1741 个节点。`out/main/mint-BD6JbBCV.js` 的语义图超出单文件节点上限，静态模块事实还在，动态 IPC 未配对。
- 辅助：`Info.plist`、`app-update.yml`、渲染进程 `bundle-report.md`（构建 `ffebce626d04b937d731ce0c140ed4e174b99ed2`，profile `desktop`，channel `stable`），以及对 `kappu-macos` 的 `strings`。没有在这台 Linux 上启动这个 arm64 应用，也没有用 Ghidra 反编译原生代码。
- 产品说明：[Desktop app and devices](https://docs.capy.ai/desktop)、[下载页](https://capy.ai/download)、[文档索引](https://docs.capy.ai/llms.txt)。
- Mikka 对照：`apps/desktop/README.md`、`apps/desktop/src/preload/index.ts`、`docs/design/orchestration.md`、`docs/design/decisions/2026-11-02-1723-desktop-adds-this-computer.md`。

## Capy 这个包实际是什么

壳很小，界面是整站。

| 部分 | 包里的事实 |
| --- | --- |
| Electron 主进程 | `app.asar` 里 `@capy/desktop@0.7.2`，入口 `out/main/main.js`。另外有 `sessions-BHwmEZgT.js`（`@lydell/node-pty`）、`import-worker.js`、`mint-BD6JbBCV.js` |
| 渲染进程 | `Contents/Resources/renderer/`，TanStack 路由，gzip 后 JavaScript 约 8.2 MB。线程、Captain、Issue、Drive、自动化、PR、设置都在这份本地构建里 |
| 原生辅助 | `kappu-macos`（通用二进制，x86_64 + arm64）、`notification-access.node`、`node-pty`、`tree-sitter`、`sharp`、Squirrel。更新源是 CloudFront 上的 generic feed |
| 预加载桥 | `contextBridge` 名称 `capyDesktop`。REA 收齐 100 个成员，未知成员 0 |

`capyDesktop` 上能直接看到的本机能力：

- 会话：邮箱登录、注册、验证码、SSO 续接、token、登出。
- 设备：登记、选目录、扫描、关联文件夹、克隆仓库并报告进度、初始化 Git、安装 Git、校验仓库、读文件、在 Finder 中显示、用编辑器打开、开终端、列出本机 PR 并做 diff / act。
- 窗口：新窗口、关窗口、标签命令（新建、关闭、关闭其他、重新打开、固定、下一个、上一个、复制 URL）、托盘、登录时启动、防止休眠、退出前询问。
- 预览：独立 guest 窗口，可清掉、可开 devtools。
- 导入：`import-worker.js` 读本机 Claude Code 与 Codex 的会话记录（`session_index.jsonl`、`agent_message`、`subagent`），用 worker 跑，带 `orgId` / `userId` / `catalogIds`。
- 通知、下载、外部链接、崩溃日志、artifact 的创建和打开。

`kappu-macos` 的用法字符串是 `kappu-macos --socket <path>` 或 `kappu-macos keep-awake`。符号和错误文本指向 Accessibility 树、窗口、点击、按键、粘贴、截图、ScreenCaptureKit。主进程在缺少这个二进制时写 `kappu-macos-launch-failed`。设备 API 里另有 `computer-use` 的 grant / deny / revoke，和 agent access 分开。这是本机电脑操作，不是云端桌面。

主进程里还有一批云端机器服务的字符串（`worktree_ensure`、`tailscale_join`、`volume_capture`、Linux `computer.screen`）。它们和桌面 IPC 在同一个打包文件里。不能据此说 Mac 应用自己在用户电脑上执行 Tailscale 加入。官方文档把 Tailscale 放在云端机器上，把本机线程放在用户选的文件夹里。

## 已经对齐的部分

- 两边都是 Electron，桌面端加载自己带的界面，不临时下载页面。Mikka 用 `mikka://app`；Capy 把同一套路由打进 `renderer/`。
- 装上并登录之后，这台电脑成为一台可调度的设备。Mikka 的规则在 [2026-11-02-1723](../design/decisions/2026-11-02-1723-desktop-adds-this-computer.md)。Capy 用设备登记和 device code。
- 本机执行都走真实仓库和本机 Git，而不是再套一层远程沙箱。Mikka 的合同在 `docs/design/orchestration.md` §3。
- 更新都走 `electron-updater`。Mikka 用 GitHub Releases；Capy 用 generic CloudFront feed，包标识还有 nightly / staging / preview。
- 系统通知、打开外部链接、本机选仓库，Mikka 的预加载桥已经有。

## 差距

按用户能感觉到的差别排，不按对方源码模块排。

### 1. 本机线程还不能像选一台电脑那样选一个检出

Capy 文档写明新线程可选：新建 worktree（默认）、已有 worktree、当前检出。桌面包里对应的是克隆、关联目录、worktree 列表、校验仓库。

Mikka 的 daemon 会给任务建 worktree，桌面端对外只有 `device.pickRepo`。`apps/desktop/README.md` 把通用本机设置、预览 scheme、保存的标签标成 deferred。人不能在桌面端上选择「就在我现在的检出里跑」或「另开一个 worktree」，也不能从应用里打开编辑器、终端或本机 PR diff。

### 2. 壳是一个窗口，不是一套本机窗口

Capy 的菜单和 IPC 覆盖多窗口、标签、托盘、登录项、防休眠、预览窗、`capy://`。下载页写的差别就是：原生标签和窗口、Slack 与浏览器链接进应用、后台更新，以及这台电脑在线时其他设备可以在它上面跑线程。

Mikka 主进程有主窗口、登录子窗口和更新闸门。`setWindowOpenHandler` 用来拦外部打开，不是标签系统。README 已把 saved tabs 标成 deferred。

### 3. 没有把本机 Claude Code / Codex 历史收成线程

Capy 0.2.0 的更新说明和 `import-worker.js` 的字符串一致：首次设置可以导入这两边的历史。Mikka 不读 `~/.claude` 或 `~/.codex` 的会话文件。

### 4. 线程不能在本机和云之间搬

Capy 文档：线程可以在云、另一台设备、这台电脑之间跑，进行中可以搬。本机线程不计机器时间。

Mikka 在机器消失时会换一台继续（云沙箱没了就按分支新开；服务器或个人电脑离线则按 E2B、参与调度的电脑、结束这三步）。这是故障转移，不是人在线程里点「改到这台 Mac」或「改回云」。一次 run 的机器在创建时定下。

### 5. 本机电脑操作是另一条产品线

Mikka 的屏幕操作在带桌面的云机器上，线程不驱动 Bot 自己的桌面。Capy 在 Mac 包里放了 `kappu-macos`，并用单独的 computer-use 授权。补这一条要先有决定。它不是把现有云桌面搬到本机就能完成的。

### 6. 无界面配对还停在 SSH

Capy 的 Dock CLI 用 device code 把一台没有桌面的机器配成设备。Mikka 添加其他电脑是 SSH 安装，最后才是手动命令。daemon 本身已经是那台机器上的执行器。缺的是不依赖 SSH 的配对，不是再写一个执行器。

### 装进同一个包、但不是桌面壳缺口的东西

渲染进程路由和主进程里的 API 名还包含 Captain、Issue、Drive、自动化、Review 规则、插件市场、Revyl 云手机、Paper、Tailscale、以及 GCP / AWS / Azure / Vault 的 OIDC。官方文档把它们写成产品能力。它们出现在桌面包里，是因为桌面端携带整站。

Mikka 已有 Coordinator、Factory 的 review / verify、Slack、Linear、MCP、以及按密钥边界投递的本机执行。这些不是同一功能的缺页。要不要做 Captain、云手机或云厂商 OIDC，是产品范围，不是这个 DMG 暴露出来的壳上漏洞。

## 怎么补

沿现有桌面桥和 daemon 补，不把对方的主进程或 `kappu-macos` 搬进来。

1. **本机检出。** 在现有设备上补齐 Capy 那组设备 IPC 的用户动作：关联文件夹、扫描、克隆并显示进度、校验仓库、在新建 worktree / 已有 worktree / 当前检出之间选择、用本机编辑器打开、开一个本机终端、看本机 PR 的 diff 并执行已有的 PR 动作。执行仍走 daemon 的 worktree 和进程组。
2. **壳。** 实现 README 里已经标成 deferred 的预览和保存标签，并补上多窗口、托盘、登录项、防休眠、以及能把 Slack / 浏览器链接打开回应用的 scheme。更新链路保持现在的 GitHub Releases。
3. **导入。** 首次进入时只读本机 Claude Code 与 Codex 的会话文件，变成 Mikka 线程。失败留在导入结果里，不写回对方的会话目录。
4. **换机器。** 在现有「机器消失就换台继续」之外，增加人发起的搬迁：同一条线程对话，从本机 worktree 继续到云分支，或从云分支继续到本机 worktree。run 仍然一次一个机器。
5. **无 SSH 的设备码。** 给已经存在的 daemon 增加 device code 登记，让没有 SSH 的服务器走和桌面端相同的上线结果。
6. **本机电脑操作先停住。** 在 Alex 明确要「线程操作这台 Mac 的屏幕」之前不做。若要做，单独一个辅助进程，带 grant / deny / revoke，默认不随每次任务启动。

第 1 到第 3 步用现在的 daemon、桌面桥和会话库就能验收。第 4 步碰到线程与 run 的机器绑定。第 5 步只加配对。第 6 步等待决定。
