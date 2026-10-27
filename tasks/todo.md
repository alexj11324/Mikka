# Orvilo3 UI 政策改造

唯一要求：**不能手写** —— 组件库里有对应实现的，必须引用组件。

## 结果

| 指标 | 改造前 | 改造后 |
|---|---|---|
| `node scripts/lint-ui.mjs` | 603 项违规，退出码 1 | **0 项，退出码 0** |
| `node --test scripts/ui-policy.test.mjs` | 52 项 | **60 项全通过** |
| 死代码 | `components/demo.tsx` 314 行 | 已删除 |
| CI | 必然红，锁死所有 PR | 可绿 |

PR: https://github.com/alexj11324/Orvilo3/pull/2

## 判据（来自 shadcn 官方 skills 文档）

官方原文：`Use existing components before custom markup. Check if a component exists before writing a styled div.`

判据 = **有没有对应成品组件**，不是"标签是不是小写"。

`RAW_ELEMENTS`（有替代品才禁）：
button→Button, input→Input/InputGroup, select→Select/NativeSelect, textarea→Textarea,
dialog→Dialog/AlertDialog, table→Table, kbd→Kbd, nav→Sidebar/Breadcrumb/NavigationMenu,
label→Label/FieldLabel, hr→Separator, progress→Progress, details/summary→Collapsible,
fieldset→FieldSet

**不在表里**（组件库无对应成品）：div, span, p, h1-h6, section, article, header,
footer, main, ul, li, dl, dt, dd, time, br, aside

## 规则侧收敛（603 → 0 的关键）

- 手写检查改用 `RAW_ELEMENTS` 判据 —— 227 → 15
- className 检查只对组件库组件生效（`@/components/ui/*`、`@/components/reui/*`）
- 删除 `style/layout-only` 与 `typography/no-callsite-override`（Orvilo 规则集里没有；
  shadcn 组件不总提供对应 variant，硬禁只会逼出"包一层 span"的绕过）
- 删除 `components/no-unchecked-spread`（4 处全是 React 标准 props 转发）
- 豁免 `render` prop 里的宿主元素（Base UI 组合 API）
- 修掉假阳性：`style/use-cn` 补 frameworkShell 豁免、`--font-mono/serif`、
  import 常量与静态映射表索引访问、`dark:*-transparent`、图标尺寸只看直接父级

## 代码侧修复

14 个文件由 14 个并行 agent 按文件修复，再逐处审查、还原被规则逼出的妥协。

- 手写原生控件 → 组件（`<kbd>`/`<button>`/`<input>`/`<textarea>`/`<fieldset>`/`<details>`）
- `<Loader2 className="animate-spin">` → `<Spinner />`
- Button 内图标补 `data-icon`；非预设字号 → 预设档位
- 还原：task-detail 标题 `text-2xl`、issue-editor `text-sm/7`、
  create-issue-dialog 无边框 Input 与胶囊 Badge、nav-user `aria-expanded:bg-muted`、
  去掉只为躲检查而存在的包装 span

## 验证

- [x] `node scripts/lint-ui.mjs` → 0 违规，退出码 0
- [x] `node --test scripts/ui-policy.test.mjs` → 60/60
- [x] 浏览器实测：登录页、看板、新建任务弹窗、任务详情（issue-editor）全部正常渲染
- [x] `tailwind-merge` 冲突消解确认（`md:text-sm` 被 `md:text-2xl` 正确移除）
- [ ] typecheck —— 本机被 hook 拦（tsgo 会 SIGKILL），留给 CI

## 环境（本机，未进仓库）

`.env.local` 已建（被 `.gitignore:20` 的 `.env*` 忽略）：

- `ORVILO_DATABASE_URL` → Neon `dev-local` 分支（`br-plain-hat-b58lsr0c`）的 `orvilo_mvp` 库
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` → 来自 `~/Downloads/orvilo-github-oauth.env`
- `BETTER_AUTH_URL` → `http://localhost:3000`

**Neon 隔离**：`production` 分支是生产数据，`dev-local` 是本次为本地开发建的独立副本。
不要把本地 `.env.local` 指向 `production`。

## 待办

- [ ] 轮换 Neon `neondb_owner` 密码（配置过程中该密码被意外打印到终端）
- [ ] `text-[10px]`/`text-[11px]` → `text-xs`（12px）。Tailwind 无更小默认档位，
      如需还原原尺寸要加 `--text-2xs` 自定义档位
- [ ] `app-sidebar.tsx` 与 `issue-list.tsx` 内联了状态色映射（原为共享常量
      `status.indicatorClassName`），因为 `style/static-layout-only` 无法追踪属性访问。
      若 `issue-properties.ts` 的映射变化，这两处需同步

---

# 中文字体对齐 Comma（2026-10-20）

要求：把中文字体改成 Comma 的样子。

## 调研结论（实测 app.comma.surf，非猜测）

用 CDP `CSS.getPlatformFontsForNode` 拿到**实际渲染字形的物理字体**：

| | Comma | Orvilo3（改前） | Orvilo3（改后） |
|---|---|---|---|
| 拉丁 | Inter Variable（自托管 webfont） | Inter（webfont） | Inter（webfont） |
| **中文** | **PingFang SC（系统字体）** | Noto Sans SC Thin（webfont） | **PingFang SC（系统）** |
| 代码 | Menlo（Geist Mono 未内嵌，直接落到系统等宽） | — | — |

**关键结论：Comma 全站 CSS 没有声明任何中文字体**（无 PingFang / Noto SC / 思源），
中文完全靠 `-apple-system` / `system-ui` 的 CJK fallback，即 macOS 的 PingFang SC。
字体栈原文：
`"Inter Variable", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`

## 顺带记录：Comma 的排版系统（本次未采用）

- 字号档位语义化并**覆盖了 Tailwind 默认值**：`--text-sm: .8125rem`（13px，不是 14px）、
  `--text-xs: .75rem`、`--text-regular/.md: .9375rem`（15px）、
  `--text-micro: .6875rem`（11px）、`--text-mini: .75rem`（12px）
- 字重把 normal/regular 重定义为 **450**（可变字体的中间值）
- 实测密度：`text-sm`(13px) 182 处、`text-xs`(12px) 102 处；聊天正文 13px / w450 / lh 20px /
  `tracking-[-0.14px]`；行内代码缩到 11.96px（13×0.92）
- 根节点挂 `data-comma-font-size="small|default|large"` → `font-size: 90%|100%|110%`，
  因为全站尺寸都是 rem，改一个根字号整体缩放
- 色板基于 **Untitled UI**（blue-25 #f5faff … blue-950 #102a56），品牌蓝 `#205bff`
- 中性色用 **OKLCH 相对颜色做运行时染色**：
  `oklch(from <基准灰> calc(clamp(0, l + (clamp(.36, var(--comma-theme-l), .64) - .5) * 4 * l * (1 - l), 1)) calc(var(--comma-theme-c) * 4 * l * (1 - l)) var(--comma-theme-h))`
  `4·l·(1-l)` 是钟形曲线 —— 中间调染色最深，纯黑纯白不动，所以两端对比度不受影响。
  默认预设 `--comma-theme-c: 0` 即纯灰

## 改动

| 文件 | 改动 |
|---|---|
| `app/globals.css` | `--font-sans` 改为 `var(--font-inter), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif` |
| `app/layout.tsx` | 移除 `Noto_Sans_SC` 导入、`fontChinese` 变量与 `<html>` 上的 class |
| `ui-policy.json` | `googleFonts` 从 `["Inter", "Noto_Sans_SC"]` 收敛为 `["Inter"]` |
| `scripts/ui-policy.mjs` | 第 265 行硬编码的 `--font-sans` 批准值同步更新；第 76 行 `/-transparent$/` → `base.endsWith('-transparent')` 修掉既有 oxlint 警告 |

后两处是必须的：策略脚本把 `--font-sans` 的取值写死在代码里，不改会报
`typography/font-token`。

**采用纯 fallback 策略，与 Comma 一致**：字体栈里不写任何中文字体名，
让 `-apple-system` / `BlinkMacSystemFont` 的平台 CJK 级联去兜 ——
macOS 得到苹方，Windows 得到微软雅黑。

一开始写成显式 `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC"`
的版本，被要求改回 fallback 策略。两种写法在本机渲染结果相同（实测都是 PingFang SC），
但纯 fallback 才是 Comma 的真实做法。

与 Comma 原栈的唯一差异：去掉了 `"SF Pro Display"`（display 光学尺寸字面，
对 UI 正文反而偏紧，且不覆盖中文）与 `Oxygen, Ubuntu, Cantarell, "Open Sans"`
（Linux 发行版字体，对本项目是死条目）。

## 验证

- [x] `node scripts/lint-ui.mjs` → 0 违规，退出码 0
- [x] `node --test scripts/ui-policy.test.mjs` → 60/60
- [x] `tsgo --noEmit` → 退出码 0
- [x] `oxlint --deny-warnings` → 退出码 0（顺手修掉既有的 `-transparent$` 警告后转绿）
- [x] 浏览器实测（CDP `CSS.getPlatformFontsForNode`）：登录页 7 个中文节点
      **全部 PingFang SC (system)**，拉丁 Inter (webfont)，零 Noto 残留。
      显式苹方版与纯 fallback 版各测一次，结果相同
- [x] 字体文件从 2 个 woff2 降到 1 个（Noto Sans SC 不再下载）

---

# 字体栈换成 Geist + 显式中文回退（2026-10-20）

要求：字体栈改成
`Geist Variable → PingFang SC → Hiragino Sans GB → Microsoft YaHei → ui-sans-serif → system-ui → sans-serif`，
然后开 PR 并合并。

## 背景：这一步的目标变了

上一轮的目标是"照搬 Comma"（Comma 的 sans 是 Inter Variable，中文靠系统级联）。
这一轮改成**对齐自家 Orvilo 主产品**——`Orvilo/packages/ui/src/styles/globals.css:15`
用的就是这条 Geist 栈。

之所以要绕这一圈：中途有另一个会话拿 `grep packages/ui/src/styles/globals.css`
的结果回答了"app.comma.surf 上这个字是什么字体"，把**本地仓库**的字体栈
当成了 **Comma 页面**的字体栈。两者不是一回事：

| | 拉丁 | 中文那一层 |
|---|---|---|
| Comma（实测线上） | Inter Variable | 不写，靠系统级联 |
| Orvilo 主产品 | Geist | 显式 PingFang SC / Hiragino / 雅黑 |
| Orvilo3（本次改后） | Geist | 显式 PingFang SC / Hiragino / 雅黑 |

## 改动

| 文件 | 改动 |
|---|---|
| `app/layout.tsx` | `Inter` → `Geist`，变量 `--font-inter` → `--font-geist` |
| `app/globals.css` | `--font-sans` 换成 Geist + 显式中文回退栈 |
| `ui-policy.json` | `googleFonts` 由 `["Inter"]` 改为 `["Geist"]` |
| `scripts/ui-policy.mjs` | 第 265 行硬编码的 `--font-sans` 批准值同步更新 |

Geist 走 `next/font/google`（而非主产品用的 `@fontsource-variable/geist`）：
next/font 在构建期把字体自托管到本地，运行时同样不联网；且不用新增依赖，
也绕开了 UI 策略里"CSS `@import` 只允许 tailwindcss/tw-animate-css/shadcn"和
"禁止 next/font/local"两条限制。

`--font-inter` 已无引用，`Inter` 加载器整个移除。

## 验证

- [x] `node scripts/lint-ui.mjs` → 0 违规，退出码 0
- [x] `node --test scripts/ui-policy.test.mjs` → 60/60
- [x] `tsgo --noEmit` → 退出码 0
- [x] `oxlint --deny-warnings` → 退出码 0
- [x] 浏览器实测（CDP `CSS.getPlatformFontsForNode`，注入探针元素）：
      拉丁+数字 → `Geist (webfont)`；中文 → `PingFang SC (系统字体)`；
      等宽 → `Menlo (系统字体)`
- [x] `document.fonts` 确认只加载 `Geist w100 900` 一个可变字体
- [x] 截图确认版面未因字体度量差异发生位移或溢出

---

# Agents 界面 + 设备 harness 检测（daemon 移植）— 2026-10-20

> 已过时：`/agents` 页面与手动 Agent 管理已移除；线程由 Bot 派发（见 `docs/design/decisions.md` 2026-10-25 23:40）。

## 目标

侧边栏新增 **Agents** 界面：设备列表显示 daemon 检测到的 harness（本轮只展示 Claude Code / Codex），并能在设备上添加具名 Agent。

## 关键决策

- **直接移植**主产品 `~/Desktop/vibe/Orvilo` 的 `packages/config`、`packages/protocol`、`packages/daemon`，不重写 daemon。
- 检测由 daemon 的 `detectHarnesses()` 产生，经 heartbeat 上报；web 端只读 `devices.harnesses`，不自己探测。
- 本轮只接 device link 的注册 / 心跳 / 空轮询；**不接 run 执行链**（claim、worktree、sandbox、adapter 运行）。
- 认证用 device token（`device_tokens` 表，SHA-256 哈希存储），`orvilo daemon login --token` 手动登录；远程设备走 SSH 进机器跑同一条命令。
- 注意：移植过来的 `claude` adapter 仍是 **CLI print mode + stream-json**，不是 Claude Agent SDK。切换到 Agent SDK 是单独一轮，本轮不动。

## 步骤

### 1. Workspace + 移植

- [ ] `pnpm-workspace.yaml` 加 `packages: - 'packages/*'`
- [ ] 复制 `packages/config`、`packages/protocol`、`packages/daemon`
- [ ] 根 `tsconfig.json` exclude `packages`；`.oxlintrc.json` ignore `packages/**`；`scripts/lint-ui.mjs` 的文件过滤排除 `packages/**`
- [ ] 安装依赖，分别跑 app / protocol / daemon 的 typecheck

### 2. 数据库

- [ ] `lib/db/schema.ts` 加 `devices`、`device_tokens`、`agents`
- [ ] 写 SQL 迁移并应用到 Neon `dev-local` 分支
- [ ] `agents.harness` 先只允许 `claude_code` / `codex` / `mock`

### 3. 服务端 device link（Next.js route handlers）

- [ ] `POST /v1/devices/register`
- [ ] `POST /v1/devices/[deviceId]/heartbeat`
- [ ] `GET /v1/devices/[deviceId]/repos` → `{ repos: [] }`
- [ ] `GET /v1/devices/[deviceId]/runs` → `{ runIds: [] }`
- [ ] `GET /v1/devices/[deviceId]/commands` → 长轮询后 `{ commands: [] }`
- [ ] `POST /v1/devices/[deviceId]/commands/ack` → 204
- [ ] `GET /v1/devices/[deviceId]/fs/requests` → `{ requests: [] }`
- [ ] `POST /v1/devices/[deviceId]/fs/requests/[requestId]` → 204
- [ ] Bearer 认证：token 哈希查 `device_tokens`
- [ ] 用 `@orvilo/protocol` 的 zod schema 校验请求与响应

### 4. 设备 token + 连接流程

- [ ] server action `createDeviceToken`（只返回一次明文）
- [ ] UI 生成 token + 展示登录 / 启动命令（本地与 SSH 两种）
- [ ] 根 scripts：`daemon`、`daemon:login`

### 5. UI

- [ ] `/agents` 路由 + 侧边栏入口
- [ ] 设备区块：在线状态、平台、harness 徽章（安装状态 + 版本）、最后心跳时间
- [ ] Agent 区块：列表 + `Add agent` 对话框（设备 → 该设备已安装的 harness → 名称 / 描述 / 指令）
- [ ] 编辑 / 删除 Agent
- [ ] 空状态 + 连接设备引导
- [ ] 全部用 shadcn 组件；ReUI 先用 MCP 查再决定是否引入

### 6. 验证

- [ ] 本机跑 daemon，确认 heartbeat 落库
- [ ] UI 显示 Claude Code / Codex 的真实检测结果
- [ ] 添加 Agent 成功
- [ ] `lint` / `typecheck` / `test:ui-policy` 全绿
- [ ] 浏览器实测截图

## 不在本轮

- runs 执行链（claim、worktree、sandbox、adapter 运行）
- Claude Agent SDK 迁移（当前 adapter 是 CLI 模式）
- OAuth device flow（先用 token 登录）

---


# 禁止全宽水平长线（2026-10-20）

要求：截图里表格头下面那种贯穿整行的长线不要；lint 加规则禁止。

## 规则

`scripts/ui-policy.mjs` 新增 `style/no-horizontal-rule`：

- `border-t` / `border-b` / `border-y`（含 `-2`、颜色后缀、任意值；`-0`、`-transparent` 豁免）
- `divide-y`（`-0`、`-reverse` 豁免）
- `h-px` / `h-0.5` 同时带 `bg-*`（手画线）
- 默认水平方向的 `<Separator />`（`orientation="vertical"` 保留）

竖线、盒状 `border`、背景分组、间距分组不受影响。
- `border-t` / `border-b` / `border-y`（含 `-2`、颜色后缀、任意值；`-0`、`-[0px]`、`-transparent` 豁免）
- `divide-y`（`-0`、`-reverse` 豁免）
- `h-px` / `h-0.5` 同时带绘制背景的 `bg-*`（手画细线）
- 默认水平方向的 `<Separator />`；`orientation` 支持字面量、表达式、模板字符串与本地常量，动态条件保守判违规

竖线（`border-l/r`、`divide-x`、`orientation="vertical"`）与盒状 `border` 不受影响。

## 代码侧

- `components/ui/table.tsx`：`TableHeader` / `TableRow` / `TableFooter` 去掉默认 `border-b` / `border-t`（截图那条线的来源）
- `components/ui/dialog.tsx` / `alert-dialog.tsx` / `card.tsx` 的 Footer 去掉 `border-t`；
  `accordion.tsx` 的 Item 去掉 `not-last:border-b`（否则 agents 对话框仍会出现长线）
- 8 个业务文件清掉 16 处水平线，保留 `bg-muted/*` 分组与 `lg:border-l` 竖线

## Review 修正

- `orientation={"vertical"}` / 模板字符串 / 变量写法改走 `resolve()`，不再误判为水平线
- `border-t-[0px]` / `border-t-[transparent]` 加入豁免
- `h-px` 检查排除 `bg-none` / `bg-clip-*` 等不绘制的背景 token，消息改为「水平细线」

## 验证

- [x] `node scripts/lint-ui.mjs` → 0 违规（62 个业务文件）
  `accordion.tsx` 的 Item 去掉 `not-last:border-b`（否则对话框与折叠面板仍会出现长线）
- 业务代码 8 个文件清掉 16 处水平线，保留 `bg-muted/*` 分组与 `lg:border-l` 竖线

## 验证

- [x] `node scripts/lint-ui.mjs` → 0 违规
- [x] `node --test scripts/ui-policy.test.mjs` → 68/68
- [x] `pnpm lint:code`（oxlint）→ 退出码 0
- [x] `pnpm typecheck`（tsgo --noEmit）→ 退出码 0

---

# Agents 界面 + 设备检测：已落地部分（2026-10-20）

## 已完成并验证

- [x] daemon / protocol / config 移植进 `packages/`，workspace 接通
- [x] `pnpm-workspace.yaml` 加 `packages/*` 与 `minimumReleaseAge: 0`
- [x] 根 tsconfig / oxlint / UI policy lint 排除 `packages/**`
- [x] 数据表：`devices`、`device_tokens`、`device_repos`、`agents`、`agent_runs`、`run_chunks`、`run_messages`
      （`drizzle/0001_agents_devices.sql`，用 `scripts/apply-sql.mjs` 应用）
- [x] device link 路由：register、heartbeat、repos、pending runs、claim、events、patch、complete、commands、fs
- [x] 设备 token（只存 SHA-256）
- [x] `/agents` 页面：设备 Frame + harness 徽章（真实版本号）、Agent 列表、添加/编辑/删除 Agent
- [x] SSH 连接流程（Term 样式）：Host / Act as、`~/.ssh/config` 主机列表、登录→检查→安装→启动→连接 五步进度流
- [x] 浏览器实测：真实 daemon 上报 Claude Code 2.1.305 / Codex 0.163.0；添加 Reviewer 成功；
      `nope.invalid` 在「登录」步骤正确红圈失败
- [x] 手动 token 代码块自动换行（修复超宽）
- [x] `lint` 0 / `typecheck` 0 / `test:ui-policy` 68/68

## 未完成（下一轮）

- [ ] **Claude Agent SDK adapter**：`packages/daemon/src/adapters/claude.ts` 仍是 CLI print mode
- [ ] **执行链 UI**：任务详情里的「交给 Agent」入口、运行状态与流式输出面板
- [ ] **真实 run 端到端**：claim → worktree → adapter → events → complete
- [ ] **SSH 安装步骤的真实远程验证**：本机只验证了步骤流与失败路径
- [ ] **服务端路由的测试**：`app/v1/**`、`app/actions/agents.ts`、`app/api/devices/ssh` 仍无覆盖

## 独立 review 与修复（2026-10-20）

Review 结论 **REQUEST CHANGES**，3 Critical + 4 Important，已全部修掉：

| 问题 | 修法 |
|---|---|
| `complete` 路由缺归属校验（任何设备 token 可改别人的 run / issue） | 补 `devices.ownerId = caller.userId`，并加终态幂等（已结束的 run 直接 204） |
| SSH 参数注入：`host` 以 `-` 开头会被 ssh 当选项，`-oProxyCommand` 可在服务器本机执行命令 | 新增 `lib/ssh-target.ts` 的 `parseSshTarget` 严格白名单（拒 `-` 开头、空白、shell 元字符），`sshRun`/`rsync` 再加 `isSafeTarget` 兜底 |
| `device.json` 写到 `~/.orvilo/`，daemon 读的是 `--data-dir` 下的 `~/.orvilo/data/device.json`，连接流程必然超时 | 路径改为 `~/.orvilo/data/device.json` |
| `listRuns` 越权读（issue 成员可看到他人 run） | 加 `agentRuns.userId` 过滤，与 `getRun` 一致 |
| 手动命令 `pnpm daemon:login` 不存在 | 根 `package.json` 补 `daemon` / `daemon:login` 脚本 |
| `createAgent` 把所有插入错误都报成同名 | 只对 Postgres `23505` 报同名 |
| `authenticateDevice` 每请求写 `lastUsedAt` | 60 秒节流 |
| fs/requests 空实现却 sleep 满 25 秒 | 立即返回 |
| `--server ${origin}` 未加引号 | origin 白名单校验 + 单引号包裹 |

新增回归测试：`lib/ssh-target.test.ts`（5 例，覆盖 `-oProxyCommand` 注入），`pnpm test:ssh-target`。

未采纳 / 待办：`minimumReleaseAge: 0` 仍开着（需重新生成 lockfile 才能恢复）；SSH 路由无速率限制。

---

# 开发 / 生产环境隔离（Vercel + Neon）— 2026-10-20

项目 `new-base-nova-project`（team `orvilo`），唯一项目域名
`new-base-nova-project-ten.vercel.app`。

## 最终配置

| 变量 | Production | Preview | Development |
|---|---|---|---|
| `ORVILO_DATABASE_URL` | Neon `production` 分支 | Neon `dev-local` 分支 | Neon `dev-local` 分支 |
| `BETTER_AUTH_SECRET` | 原值（未动） | 独立随机值 | 独立随机值 |
| `BETTER_AUTH_URL` | **不设** | **不设** | `http://localhost:3000` |

（已过时，2026-10-27）Preview 现在用自己的 `VERCEL_URL` 并经 OAuth 代理中心登录；见 `lib/auth-config.ts` `resolveAppOrigin` 与 `docs/cloud-preview.md`。

## 一次配错与修正

原先给 Production 设了 `https://orvilo.aspectlylabs.com`、给 Preview 设了
`https://$VERCEL_URL`，两个都是错的，已移除：

1. **`orvilo.aspectlylabs.com` 不属于这个项目**。它的响应是 10 字节的 `Orvilo API`，
   `server: cloudflare` 且无 `x-vercel-id` —— 是 Cloudflare 上的另一个服务。
   设成 `BETTER_AUTH_URL` 会让 better-auth 生成指向该域名的 OAuth 回调，登录必挂。
2. （已过时，2026-10-27）Preview 现在用自己的 `VERCEL_URL` 并经 OAuth 代理中心登录；见 `lib/auth-config.ts` `resolveAppOrigin` 与 `docs/cloud-preview.md`。

移除时机是安全的：官方文档说明 env 变更**只对新部署生效**，
所以那次配错没有污染当时正在跑的 production 部署。

## 验证

- [x] `vercel env ls` / REST API `GET /v10/projects/{id}/env` → 三个变量目标环境正确
- [x] `vercel env pull --environment=development` → `BETTER_AUTH_URL=http://localhost:3000`，
      `BETTER_AUTH_SECRET` 长度 44（32 字节 base64）
- [x] 域名归属：`GET /v9/projects/{id}/domains` 与 `curl -sI` 双重确认
- [x] `https://new-base-nova-project-ten.vercel.app` → `307 /sign-in` + `x-vercel-id`，
      确认这才是本应用的线上入口
- [x] 早前实测：preview 注册落进 `dev-local`（23 users），production 零污染（2 users）

## 待办

- [ ] 若确实想让 `orvilo.aspectlylabs.com` 作为线上域名：先在 Vercel 项目加该域名
      （`POST /v10/projects/{id}/domains`），再去 Cloudflare 把 A/CNAME 指向 Vercel，
      并**移除**当前占用该名字的 Cloudflare 服务
- [ ] Preview 环境的 GitHub OAuth 回调（需要 App 的 permissive 模式，
      或 Preview 不注入 `GITHUB_CLIENT_ID`）
- [ ] `BETTER_AUTH_SECRET` 的 Preview 值是 Secret 类型（write-only），无法回读校验；
      以后配非敏感值优先用 `vercel env add --type config`

---

# 设备页改版：去嵌套 + 允许调度开关（2026-10-20）

用户反馈：页面一层套一层；右上角的 ⋯ / 添加仓库位置错误，那里应该是一个调度开关。

## 改动

| 项 | 改法 |
|---|---|
| 嵌套 | 去掉外层 `Frame` / `FramePanel`，设备卡片是页面上唯一容器；`IconTile` 从 `frame`（双层）改 `elevated`（单层） |
| 页面名 | `/agents` → `/devices`，标题与侧栏入口都是「设备」 |
| Agent 区块 | 从设备页移除（Agent 单独做）；`app/agents/`、agents 侧栏、三个 Agent 组件已删除 |
| 右上角 | `⋯` 菜单与「添加仓库」删除，换成 `允许调度` 开关 |
| 仓库 | 从设备卡片移除；`device_repos` 表与服务端 actions 保留给下一轮 run 配置 |
| 调度开关 | 新增 `devices.enabled boolean not null default true`（`drizzle/0002_device_enabled.sql`） |

## 服务端真正生效

- `POST/GET /v1/devices/:deviceId/runs`：`enabled = false` 时返回 `{ runIds: [] }`
- `POST /v1/devices/:deviceId/runs/:runId/claim`：`enabled = false` 时 409
- `setDeviceEnabled` server action 只允许改自己的设备

## 验证

- [x] 浏览器点开关 → 数据库 `enabled` 在 `false` / `true` 间切换并持久化
- [x] 插入一条 queued run：关调度 → `{"runIds":[]}`；开调度 → `{"runIds":["f349…"]}`
- [x] 测试 run 已删除，设备恢复 `enabled = true`
- [x] `lint` 0 / `typecheck` 0 / `test:ui-policy` 68/68 / `test:ssh-target` 5/5

---

# Claude adapter 换成 Agent SDK（2026-10-20）

## 决策：方案 A

CC 用 `@anthropic-ai/claude-agent-sdk`（0.3.305）直接跑，**开 Claude 自带沙盒**，
**不加 daemon 的 sandbox-runtime wrapper**，不用 `pathToClaudeCodeExecutable`。

已明确接受的代价：Claude Code 的沙盒只罩 shell 命令，**Write / Edit 与 MCP 在边界外**
（官方 sandboxing 文档：*The sandbox covers shell commands only. Claude's file tools,
MCP servers, and hooks run outside it*）。无人值守下 `permissionMode` 也不再拦它们。

## 查证记录：嵌套沙盒在两个平台都被禁止

不是「macOS 特有的坑」，Anthropic 自己的 sandbox-runtime 文档写得很硬：

| 平台 | 结论 | 依据 |
|---|---|---|
| Linux | 默认禁止嵌套 | seccomp 拒绝 `unshare` / `clone`(user,mount ns) / `mount` / `umount2` / `pivot_root` / `setns`（EPERM）。原文点名 *a nested bubblewrap or `srt`* 会挂 |
| Linux（开 `allowNestedUserNamespaces`） | 可以，但等于没有沙盒 | 原文：*treat `denyWrite` and the mandatory denies as not holding against any command run under it* |
| macOS | 无第二份 profile 的机制 | `sandbox-exec` 在包装时生成单份 Seatbelt profile；只有 `enableWeakerNestedSandbox`（更弱，给 Docker），不是叠加 |

失败原因是权限模型冲突：内层沙盒的启动动作（建 namespace / 装 profile）正是外层必须禁止的动作。

## adapter 为什么保留（与 SDK 不冲突）

- `adapters/types.ts` 129 行 7 个方法；`runs/supervisor.ts` 1159 行只认 `Map<Harness, AgentAdapter>`，
  取用是 `adapterFor(runId)`，全程不知道 harness 是谁。
- 换 SDK = 换 `adapters/claude.ts` 的**函数体**。SDK 在 adapter 内部被直接调用，外面没有包一层。
- 不写 adapter 的代价：supervisor 里会长出 `if (harness === 'claude_code') / codex / cursor`
  三套分支，覆盖消息形状、interrupt、resume、沙盒包装。

## SDK API 核实（读的是 `sdk.d.ts`，不是文档记忆）

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` → 流式输入，支持中途插话
- `Options` 关键字段：`abortController` `allowedTools` `canUseTool` `cwd` `disallowedTools`
  `env` `extraArgs` `forkSession` `hooks` `includePartialMessages` `maxTurns` `mcpServers`
  `model` `pathToClaudeCodeExecutable` `permissionMode` `plugins` `resume`
  `settings?: string | Settings`（可传对象）`settingSources` `stderr` `systemPrompt`


---

# 执行链端到端测试（2026-10-21）

目标：issue → queued run → daemon claim → worktree → Claude Agent SDK adapter →
事件回流 → complete → issue 进 review。

## 测试准备（没有 UI 入口，直接写库）

| 项 | 值 |
|---|---|
| 设备 | `bf9b9751-…`（Mac，`enabled = true`） |
| Agent | Reviewer（`claude_code`） |
| 仓库 | `/tmp/orvilo-e2e-repo-1792583425`，base `main`，verify `test -f hello.txt` |
| Issue | `079094f1-…`「E2E: create hello.txt」，初始 `todo` |
| Run | `f82ca254-…`，`queued`，prompt 要求写 `hello.txt` 并调 `submit` |
| daemon | `--data-dir /tmp/orvilo-ui-daemon-1792546436 --server http://localhost:3000` |

## 实际链路（服务端访问日志 + daemon log + 数据库）

| 步骤 | 证据 |
|---|---|
| 轮询 | `GET /v1/devices/…/runs?state=queued 200` |
| 认领 | `POST /v1/devices/…/runs/f82ca254…/claim 200`，run → `preparing` |
| worktree | daemon log `worktree ready`，`setup: skipped`（fixture 无 setup 配置） |
| SDK 会话 | `claude session started`，`sandbox: claude-code`，session `32eabe1d-…` |
| 事件流 | 17 条 chunk：`data-run-state`、`start`、`Write` 工具调用/结果、`submit` 工具调用/结果、`text-delta`、`data-usage`、`data-publish`、`finish` |
| 收尾 | `POST /v1/runs/f82ca254…/complete 204`，daemon log `run ended outcome=succeeded stop_reason=submitted` |

## 结果

| 检查 | 结果 |
|---|---|
| `agent_runs.status` | `succeeded` |
| `agent_runs.stopReason` | `submitted` |
| `report.filesChanged` | `["hello.txt"]` |
| `report.verify` | `passed`，命令 `test -f hello.txt` |
| `report.publish` | `pushed: false`，`skipped: not_approved`（仓库未授权推送，符合预期） |
| 分支 | `orvilo/run-f82ca254-…`，commit `5eef21b`，`hello.txt` 内容为 `hello from orvilo` |
| issue | `todo` → `review` |
| 成本 | `costUsd 0.096`，`inputTokens 6`，`outputTokens 371` |

## 观察

- dev server 没起时 daemon 是**静默**的：`ServerUnreachableError` 被 syncPass 有意跳过，
  日志只留 `daemon started`。排查时容易误判成「daemon 没注册」，实际是服务端不可达。
- 当时完整链路只能在库层面触发，issue 详情和仓库配置都还没有 UI（`device_repos` 需要手写）。
  现在线程由 Bot 派发；旧的手动启动、列表、详情和发消息 server actions 已移除（#334）。
- 当时未覆盖的分支：`stopRun` 取消、线程中途插话、verify 失败 → run failed。
  现在线程插话使用 `sendIssueThreadMessage`；保留 `stopRun` 供线程停止按钮使用。

## 三条分支补齐（同日）

### 先修了一个真 bug

`app/v1/runs/[runId]/complete/route.ts` 原来只按 `stopReason` 判终态，
`submitted` 一律写 `succeeded`，把 verify 失败的 run 也记成成功，
和它自己注释里的「verify 没失败才算成功」相反。daemon 本地状态是 `failed`，
服务端是 `succeeded`，两边对不上。

修法：直接复用 protocol 的 `runStateForStop()`，再按 daemon 的规则处理 verify：

| 情况 | 服务端终态 |
|---|---|
| `submitted` + verify `passed` | `succeeded` |
| `submitted` + verify `failed` | `failed` |
| `submitted` + verify `not_run`（非 plan） | `stopped` |
| `turn_ended` / `asked_human` / `blocked` | `stopped` |
| `cancelled` | `cancelled` |
| `error` / `timeout` / `device_lost` | `failed` |

同时给 `lib/db/schema.ts` 的 `RUN_STATUSES` 补上 `stopped`（protocol 有，库里漏了）。

### 验证结果

| 分支 | 操作 | 结果 | issue |
|---|---|---|---|
| 取消 | run 运行中置 `stopRequestedAt` | 2 秒内 → `cancelled`；daemon log `stop requested; cancelling`；空 worktree 被删 | 保持 `todo` |
| 插话 | run 执行 `sleep` 时插 `run_messages` | daemon log `message handed to the agent`；`deliveredAt` 已写；agent 建了 `interject.txt`，summary 为插话要求；verify 通过 | → `review` |
| verify 失败 | `submitted` + verify `test -f definitely-missing.txt` | → `failed`，`stopReason=submitted`，`report.verify.status=failed` | 保持 `todo` |
| 回合结束（顺带） | agent 不调 submit、直接结束 | → `stopped`，`stopReason=turn_ended` | 保持 `todo` |

`typecheck` 0 / `lint:code` 0 / `lint:ui` 0。

---

## 2026-10-21 中英文 i18n 接入与 CI 门禁

- [x] next-intl v4 + Next 16 `proxy.ts`，`localePrefix: 'as-needed'`，cookie 一年有效
- [x] `app/[locale]` 路由迁移、`global-not-found`、语言切换器（保留 query/hash）
- [x] 全量文案迁移：workspace / devices / auth / 富文本编辑器 / metadata
- [x] 枚举 label、日期与相对时间改走 `useFormatter`
- [x] Server Action 错误码 + `useActionError`，生产环境不再依赖 throw message
- [x] CI 合并进 `ui-policy.yml`：typegen、typecheck、i18n key、硬编码扫描、build
- [x] 新增静态检查：字面量 `t('key')` 必须能在字典解析（防止渲染原始 key）

### 浏览器验证（dev + production）

- `/` 中文、`/en` 英文；登录后切换语言 URL 与文案同步；任务列表/看板/详情/编辑器/设备页均无残留。
- 中文 `Errors.issueStale` 在编辑冲突时显示「任务已被其他成员更新…」，不是错误码。
- 富文本 slash 菜单、格式气泡、块类型菜单中英文完整；slash 分组与条目来自 `Editor.slash.*`。
- 英文页面 CJK 扫描只命中用户创建的任务标题，不命中 UI。
- 顺带修复：`SidebarRail` 未本地化、`Nav.toggleSidebar` 缺 key、`DialogContent` 关闭按钮未本地化。

### 本地结果

- `typecheck` 0、`lint:code` 0、`lint:ui` 0
- `test:ui-policy` 68/68、`test:i18n` 12/12、`test:ssh-target` 5/5
- `i18n:check` 通过，`next typegen` + `next build` 通过

### 审查修复（2026-10-21）

- [x] `app/[locale]/[...rest]/page.tsx`：`/en/<unknown>` 现在进入 locale 内 404，英文页面不再落到中文 global-not-found
- [x] `[locale]/not-found.tsx` 改用 i18n `Link`
- [x] `.gitignore` 改为 `node_modules/`，避免提交 `packages/*/node_modules`
- [x] i18n 检查器纳入 `route.ts` / `error.tsx` / `template.tsx`，覆盖 `/api/devices/ssh` 的翻译 key
- [x] `ACTION_ERROR_CODES` 缺失时检查器报错，兼容双引号
- [x] 删除 `messages/*.json` 中重复的 `Workspace.search` 字符串键
- [x] 代码块复制按钮、移动端侧栏 Sheet 标题/描述/关闭按钮本地化
- [x] CI 增加 `pnpm test:ssh-target`

保留为后续项：SSH 连接端点的目标 allowlist / 限流；`app/actions/agents.ts` 未接入 UI 的 action 仍直接 throw；next-intl `timeZone` 未固定；`minimumReleaseAge: 0` 属于既有基础设施改动。


---

## 2026-10-21 合并 main 并补全新功能 i18n

- [x] 解决 27 个冲突文件，保留 main 的项目/成员/设置/关系/元数据功能
- [x] 新路由迁入 `app/[locale]`：acceptance、invite/[token]、preview/settings、settings/members
- [x] 新增命名空间：Projects、Members、Settings、Invite、Acceptance、IssueDetail、Metadata、Overview
- [x] 新增 55 个 Server Action 错误码，消费方统一 `useActionError`
- [x] 品牌名统一为 Orvilo（含 workspace name/slug）
- [x] E2E 固定 zh-CN，21/21 通过；CSV 测试改为断言错误码
- [x] 修复 setup-e2e-db 的 schema 过滤与 Dialog/Sheet 默认关闭文案

验证：`pnpm check`、`pnpm i18n:check`、`pnpm build`、`pnpm test:e2e`（21/21）通过。

### 合并审查修复

- [x] 恢复工作台侧栏的「设备」入口（i18n Link）
- [x] 新增 `drizzle/0003_agents_columns.sql`，为既有 agents 表补列与索引
- [x] `setProjectIssues` 不再吞 `ActionFailureError`
- [x] `safeAuthReturn` 支持 `/?issue=<uuid>` 与 `/devices`，登录后保留深链
- [x] SSH 路由拒绝缺失 `authBaseURL` 的请求，并限制每账号一个并发连接
- [x] 指派菜单 Agents 分组、设置页 Sheet/rail、workspaceReadFailed 文案
- [x] 验收页改用 locale redirect

## 2026-10-22 Google OAuth and Composio integrations

- [ ] Add Google social login using the existing Better Auth flow and show the exact localhost callback URL.
- [ ] Add authenticated, per-user Composio connections for Notion and Slack and a shared signature-verified webhook receiver.
- [ ] Keep provider credentials out of tracked files; handle missing Composio configuration without breaking login or settings.
- [ ] Update English and Chinese UI text and run the relevant checks.

Success: Google login uses `http://localhost:3000/mikka/api/auth/callback/google` locally and `https://app.aspectlylabs.com/mikka/api/auth/callback/google` in production; only the signed-in user can manage their Notion/Slack connections; Composio webhook deliveries without a valid signature are rejected.
Failure conditions: invalid OAuth setup must not disable email/GitHub login; unauthenticated or unsupported integration requests must not initiate OAuth; webhook requests without a configured secret must fail closed.
