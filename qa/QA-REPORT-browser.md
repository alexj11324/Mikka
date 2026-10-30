# Mikka 浏览器交互 QA 扫描（integration/overnight-1030）

Alex 的问题：哪些按钮、开关点得通，哪些点不通，哪些地方会报错。本报告只覆盖**浏览器**；Electron 由另一个会话负责。

## 结论先看

- **真正报错（❌）2 个**：
  1. 任务详情面包屑：768px 宽、左侧列表展开时任务编号被裁掉（`EECA-1` 只剩 `EECA`）。overnight 自带的浏览器用例 `issue-header-breadcrumb.spec.ts` 在 light 和 dark 下都失败。**由 #460 引入**。
  2. 打开一个自己没有权限（或已删除）的任务链接时，`getIssue` 返回 **HTTP 500**，控制台报错。页面本身正确显示「任务不可用」。**main 上一样有（不是 overnight 引入的）**。
- **没反应 / 体验问题（⚠️）**：主要是看板「新建任务」在生产默认开关下点开就是死路；Coordinator 不可用时发消息没有任何反馈；看板视图不进 URL，刷新会回到主页；看板上的「已与 Linear 同步」绿色图标不管有没有接 Linear 都显示；中文工作区名生成不出可用的网址；英文界面下团队页搜索框的无障碍名称是一句错误提示。详见下文。
- **其余都点得通**：两轮共点了 412 个控件，判为「通」。爬虫标出的 76 个「没反应 / 超时」候选全部人工复核过：除上面几条外都是误报（隐藏的原生 input、文件选择器、已选中的选项、4 字前缀已满、空表单触发浏览器原生必填校验等），见「误报说明」。
- overnight 新功能自带的浏览器用例（Factory 验收窗口、凭据登录卡、E2B 机器名、线程提问、子 Agent 登录需求、线程停止、设置分组卡片、Coordinator 选择卡）在开关全开的服务上跑了 35 个：**31 通过**，3 失败（2 个是上面的面包屑问题，1 个缺 ffmpeg，属环境问题），1 跳过。

## 测试环境

| 项目 | 值 |
|---|---|
| 被测代码 | `9ea9871d3cb67a4117219707c7de13853334331c`（`integration/overnight-1030` 的最新提交，draft PR #476），detached 检出 |
| 对比基线 | main `68054f85`。没有重新构建 main，用 `git diff 68054f85...9ea9871d -- <file>` 判断问题是否早已存在 |
| CI 运行 | 这次运行没有关联任何 CI run（这是本地验收，不是 CI） |
| 构建 | `pnpm install --frozen-lockfile` → `build-subscription-worker` → `generate:agent-ui` → `next build`（Next 16.1.6，NODE_OPTIONS=8G），`next start --port 3100`，`MIKKA_TEST_DEPLOYMENT_SHA` = 被测 sha，`MIKKA_CREDENTIAL_HARNESS=1`（与 playwright.config 相同） |
| 运行时 | Node 22.22.0（CI 用 24）；pnpm 10.34.3；Chromium 1243（`/opt/pw-browsers`），@playwright/test 1.64.1 |
| 数据库 | 本机 PostgreSQL **16**（CI 用 17），库 `mikka_e2e`，角色 `e2e` / `e2e-local-only`，地址 127.0.0.1:5432。依次执行 `pnpm migrate`、`pnpm test:e2e:setup` |
| 测试身份 | 用现有的 `scripts/test-accounts`（`bootstrapEnvironment` → `acquireTestAccounts` / `pool.mjs`），通过正常的邮箱注册/登录拿到真实会话。CLI 的 bootstrap 只接受 GitHub runner，所以直接调用了导出的 `bootstrapEnvironment`，库归属检查照常执行。environment id 为 `local-qa-sweep-1030`。每轮用一对 owner/peer；peer 通过**真实的邀请 UI** 加入 owner 的工作区，角色为 member。凭据、cookie 和会话文件都没有写进报告 |
| 守护进程 / 模型 | 没有真实 daemon，也没有模型凭据，所以 Coordinator 不会回复。没有 COMPOSIO、Google、GitHub、Stripe、邮件服务。所有外域请求都被浏览器拦截 |
| 视口 | 桌面 1440×900，locale 为 zh-CN；移动端 390×844（isMobile）；dark 为 `colorScheme: dark`；另有一组匿名会话 |
| 时间（UTC） | 2026-10-30 12:50 – 13:40 |
| 第 1 轮开关 | 生产默认：所有 `MIKKA_*_ENABLED` 都不设 |
| 第 2 轮开关 | `MIKKA_FACTORY_ROUTING_ENABLED=1 MIKKA_FACTORY_LIFECYCLE_ENABLED=1 CREDENTIAL_VAULT_ENABLED=1 MIKKA_ISSUE_TOOLS_ENABLED=1 MIKKA_BYOS_ENABLED=1 MIKKA_BYOS_ENROLLMENT_ENABLED=1 MIKKA_PERSONAL_MAILBOX_ENABLED=1 MIKKA_PERSONAL_WRITES_ENABLED=1`。这些都是服务端运行时开关，两轮用同一个构建。BYO E2B 在代码里写死为关闭（`lib/factory/dispatch-recovery.ts:47`，等 #438），所以没有开关可开 |

方法：用一个临时爬虫（`qa/tools/crawl.mjs`）逐个打开路由，列出所有 button、link、switch、checkbox、combobox、tab、menuitem、option 和 textbox，然后逐个点击、切换、输入，或打开菜单再按 Escape。同时记录 pageerror、console.error、≥500 和非 401 的 4xx、requestfailed，以及界面有没有变化（DOM、URL、弹层、toast）。之后用 `qa/tools/verify.mjs` 对每个候选问题做人工复核，并补测关键流程。爬虫在服务器上实际执行过的变更有：改名、主题、语言、通知开关、收藏、改任务状态、评论、建 Bot、建团队、建工作区、邀请成员。

## 总览（爬虫原始计数，每页）

### 第 1 轮：生产默认开关

| 身份 | 页面 | 可交互元素 | 通 | 没反应/超时候选 | 报错 | 禁用 | 未点(破坏性/外部/文件) | 已在别页测过 |
|---|---|---|---|---|---|---|---|---|
| owner | home-chats | 28 | 14 | 2 | 0 | 2 | 1 | 0 |
| owner | suggestions | 23 | 4 | 0 | 0 | 6 | 2 | 11 |
| owner | board | 18 | 4 | 0 | 0 | 1 | 0 | 13 |
| owner | threads-agent | 14 | 0 | 0 | 0 | 1 | 0 | 13 |
| owner | plugins | 32 | 3 | 0 | 1 | 1 | 14 | 13 |
| owner | artifacts | 14 | 3 | 1 | 0 | 1 | 0 | 9 |
| owner | issue-detail | 41 | 19 | 2 | 0 | 4 | 0 | 16 |
| owner | settings-account | 26 | 19 | 1 | 0 | 1 | 4 | 1 |
| owner | settings-security | 22 | 1 | 0 | 0 | 0 | 2 | 19 |
| owner | settings-preferences | 27 | 4 | 1 | 0 | 1 | 1 | 19 |
| owner | settings-notifications | 32 | 24 | 6 | 0 | 0 | 1 | 1 |
| owner | settings-memory | 22 | 1 | 1 | 0 | 0 | 1 | 19 |
| owner | settings-connections | 36 | 0 | 1 | 0 | 1 | 15 | 19 |
| owner | settings-models | 20 | 0 | 0 | 0 | 0 | 1 | 19 |
| owner | settings-logins | 21 | 1 | 0 | 0 | 0 | 1 | 19 |
| owner | settings-privacy | 22 | 1 | 0 | 0 | 1 | 1 | 19 |
| owner | settings-activity | 23 | 2 | 1 | 0 | 0 | 1 | 19 |
| owner | settings-computers | 21 | 0 | 0 | 0 | 0 | 2 | 19 |
| owner | settings-general | 22 | 0 | 2 | 0 | 0 | 1 | 19 |
| owner | settings-permissions | 20 | 0 | 0 | 0 | 0 | 1 | 19 |
| owner | settings-members | 28 | 7 | 1 | 0 | 0 | 1 | 19 |
| owner | settings-teams | 26 | 4 | 1 | 0 | 0 | 1 | 20 |
| owner | settings-hidden-billing | 27 | 4 | 0 | 0 | 1 | 1 | 20 |
| owner | workspaces-new | 5 | 3 | 1 | 0 | 1 | 0 | 0 |
| owner | device | 3 | 2 | 0 | 0 | 1 | 0 | 0 |
| owner | dashboard | 28 | 6 | 0 | 0 | 1 | 1 | 16 |
| owner | acceptance | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| owner | preview-credential-login | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| owner | preview-subagent-login | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| owner | not-found | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| owner | thread-view | 20 | 1 | 0 | 0 | 2 | 1 | 16 |
| owner | search-palette | 33 | 1 | 4 | 0 | 6 | 1 | 21 |
| peer | home-chats | 26 | 13 | 1 | 0 | 3 | 1 | 0 |
| peer | board | 24 | 7 | 0 | 0 | 5 | 0 | 12 |
| peer | issue-detail-owner-issue | 16 | 1 | 0 | 1 (+4 加载) | 1 | 0 | 13 |
| peer | settings-general | 21 | 17 | 2 | 0 | 0 | 1 | 1 |
| peer | settings-members | 25 | 3 | 1 | 0 | 1 | 2 | 18 |
| peer | settings-teams | 25 | 3 | 1 | 0 | 0 | 2 | 19 |
| peer | settings-permissions-hidden | 19 | 0 | 0 | 0 | 0 | 1 | 18 |
| peer | settings-preferences | 26 | 4 | 1 | 0 | 1 | 1 | 18 |
| mobile | home-chats | 8 | 4 | 1 | 0 | 2 | 1 | 0 |
| mobile | board | 7 | 3 | 0 | 0 | 1 | 0 | 3 |
| mobile | issue-detail | 20 | 14 | 0 | 0 | 3 | 0 | 3 |
| mobile | settings | 9 | 4 | 1 | 0 | 2 | 0 | 1 |
| dark | home-chats | 28 | 0 | 0 | 0 | 0 | 0 | 0 |
| dark | board | 18 | 0 | 0 | 0 | 0 | 0 | 0 |
| dark | issue-detail | 41 | 0 | 0 | 0 | 0 | 0 | 0 |
| dark | settings | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| anon | sign-in | 9 | 5 | 1 | 0 | 0 | 2 | 1 |
| anon | sign-up | 9 | 2 | 1 | 0 | 0 | 2 | 4 |
| anon | forgot-password | 5 | 1 | 0 | 0 | 0 | 1 | 3 |
| anon | reset-password | 3 | 1 | 0 | 0 | 0 | 0 | 2 |
| anon | verify-email | 5 | 0 | 0 | 0 | 0 | 1 | 4 |
| anon | anon-root | 9 | 0 | 1 | 0 | 0 | 2 | 6 |
| anon | invite-bad-token | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| **合计** | | | **212** | **36** | **2** | 51 | 72 | 526 |

### 第 2 轮：overnight 开关全开

| 身份 | 页面 | 可交互元素 | 通 | 没反应/超时候选 | 报错 | 禁用 | 未点(破坏性/外部/文件) | 已在别页测过 |
|---|---|---|---|---|---|---|---|---|
| owner | home-chats | 28 | 14 | 2 | 0 | 2 | 1 | 0 |
| owner | suggestions | 23 | 4 | 0 | 0 | 6 | 2 | 11 |
| owner | board | 18 | 4 | 0 | 0 | 1 | 0 | 13 |
| owner | threads-agent | 14 | 0 | 0 | 0 | 1 | 0 | 13 |
| owner | plugins | 32 | 3 | 0 | 1 | 1 | 14 | 13 |
| owner | artifacts | 14 | 3 | 1 | 0 | 1 | 0 | 9 |
| owner | issue-detail | 41 | 19 | 2 | 0 | 4 | 0 | 16 |
| owner | settings-account | 26 | 19 | 1 | 0 | 1 | 4 | 1 |
| owner | settings-security | 22 | 1 | 0 | 0 | 0 | 2 | 19 |
| owner | settings-preferences | 27 | 3 | 2 | 0 | 1 | 2 | 19 |
| owner | settings-notifications | 32 | 6 | 6 | 0 | 0 | 1 | 19 |
| owner | settings-memory | 22 | 0 | 1 | 0 | 0 | 2 | 19 |
| owner | settings-connections | 36 | 0 | 1 | 0 | 1 | 15 | 19 |
| owner | settings-models | 20 | 0 | 0 | 0 | 0 | 1 | 19 |
| owner | settings-logins | 21 | 1 | 0 | 0 | 0 | 1 | 19 |
| owner | settings-privacy | 22 | 0 | 0 | 0 | 1 | 2 | 19 |
| owner | settings-activity | 23 | 2 | 1 | 0 | 0 | 1 | 19 |
| owner | settings-computers | 21 | 0 | 0 | 0 | 0 | 2 | 19 |
| owner | settings-general | 22 | 0 | 1 | 0 | 0 | 1 | 20 |
| owner | settings-permissions | 20 | 0 | 0 | 0 | 0 | 1 | 19 |
| owner | settings-members | 28 | 6 | 1 | 0 | 0 | 2 | 19 |
| owner | settings-teams | 26 | 3 | 1 | 0 | 0 | 2 | 20 |
| owner | settings-hidden-billing | 27 | 0 | 2 | 0 | 1 | 2 | 22 |
| owner | workspaces-new | 5 | 3 | 1 | 0 | 1 | 0 | 0 |
| owner | device | 3 | 2 | 0 | 0 | 1 | 0 | 0 |
| owner | dashboard | 28 | 6 | 0 | 0 | 1 | 1 | 16 |
| owner | acceptance | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| owner | preview-credential-login | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| owner | preview-subagent-login | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| owner | not-found | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| owner | issue-board | 37 | 9 | 0 | 0 | 2 | 3 | 17 |
| owner | issue-list | 24 | 4 | 0 | 0 | 1 | 2 | 17 |
| owner | thread-view | 21 | 5 | 0 | 0 | 1 | 1 | 14 |
| owner | search-palette | 33 | 1 | 4 | 0 | 6 | 1 | 21 |
| peer | home-chats | 26 | 13 | 1 | 0 | 3 | 1 | 0 |
| peer | board | 24 | 7 | 0 | 0 | 5 | 0 | 12 |
| peer | issue-detail-owner-issue | 16 | 1 | 0 | 1 (+4 加载) | 1 | 0 | 13 |
| peer | settings-general | 21 | 17 | 2 | 0 | 0 | 1 | 1 |
| peer | settings-members | 25 | 3 | 1 | 0 | 1 | 2 | 18 |
| peer | settings-teams | 25 | 3 | 1 | 0 | 0 | 2 | 19 |
| peer | settings-permissions-hidden | 19 | 0 | 0 | 0 | 0 | 1 | 18 |
| peer | settings-preferences | 26 | 3 | 2 | 0 | 1 | 2 | 18 |
| mobile | home-chats | 8 | 4 | 1 | 0 | 2 | 1 | 0 |
| mobile | board | 7 | 3 | 0 | 0 | 1 | 0 | 3 |
| mobile | issue-detail | 20 | 14 | 0 | 0 | 3 | 0 | 3 |
| mobile | settings | 9 | 3 | 2 | 0 | 2 | 1 | 1 |
| dark | home-chats | 28 | 0 | 0 | 0 | 0 | 0 | 0 |
| dark | board | 18 | 0 | 0 | 0 | 0 | 0 | 0 |
| dark | issue-detail | 41 | 0 | 0 | 0 | 0 | 0 | 0 |
| dark | settings | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| anon | sign-in | 9 | 5 | 1 | 0 | 0 | 2 | 1 |
| anon | sign-up | 9 | 2 | 1 | 0 | 0 | 2 | 4 |
| anon | forgot-password | 5 | 1 | 0 | 0 | 0 | 1 | 3 |
| anon | reset-password | 3 | 1 | 0 | 0 | 0 | 0 | 2 |
| anon | verify-email | 5 | 0 | 0 | 0 | 0 | 1 | 4 |
| anon | anon-root | 9 | 0 | 1 | 0 | 0 | 2 | 6 |
| anon | invite-bad-token | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| **合计** | | | **200** | **40** | **2** | 53 | 85 | 579 |

说明：

- 「通」：点击或输入后界面有可观察的变化（DOM、URL、弹层、toast 或状态属性），而且没有报错。
- 「候选」：爬虫判为「没反应」或「4 秒内点不到」。下面全部人工复核过，绝大多数是误报。
- 「已在别页测过」：左侧栏、设置侧栏等每页都有的公共控件，只测一次。
- dark 这一组只截图检查渲染，不点击（max=0）。
- 第 1 轮爬虫中途点了偏好设置里的 English，之后的设置页是英文界面，这正好也验证了切换语言是通的；第 2 轮把它排除了。
- 「看板」（任务看板 / 列表）没有自己的 URL，第 2 轮单独按 rail 进入后爬了一遍（`issue-board` 和 `issue-list` 两行）。

## ❌ 报错清单

### E1 任务详情面包屑：任务编号在中等宽度被裁掉（overnight 自带用例失败）

| 项 | 内容 |
|---|---|
| 页面 | 任务详情（从主页打开，左侧 Bot 列表处于展开状态） |
| 操作 | 窗口宽 768px，打开一个标题较长的任务 |
| 现象 | 头部面包屑里的任务编号 `EECA-1` 被截成 `EECA`；右侧的「已自动保存 / 收藏 / … / ↑↓ / ×」不收缩，把左侧挤到被 `overflow-hidden` 裁掉 |
| 错误信息 | `tests/e2e/issue-header-breadcrumb.spec.ts:63`：`expect(i.right).toBeLessThanOrEqual(c.right + 0.5)`，Expected ≤ 469.5，Received 480.23（light 和 dark 都失败） |
| 截图 | `shots-browser/E1-breadcrumb-id-clipped-768-light.png`、`shots-browser/E1-breadcrumb-id-clipped-dark.png` |
| 原因 | `components/workspace/issue-detail-header.tsx:28`：左侧容器新加了 `overflow-hidden`。`:53`：右侧操作区是 `shrink-0`，保存状态文字在窄的 `@container` 下也不隐藏。`:47-48`：`BreadcrumbItem` 是 `min-w-0`，里面的编号是 `shrink-0`，最后被父容器裁掉 |
| main 上有吗 | **没有**。`git diff 68054f85...9ea9871d -- components/workspace/issue-detail-header.tsx` 显示这套布局（`overflow-hidden`、`@container/header`、省略号菜单）是 #460 新加的。这个用例也是 #460 加的，在合并后的提交上就失败 |
| 建议修法 | 二选一：让左侧容器至少保留编号的宽度（编号放到 `min-w-0` 的 Item 之外，或给左侧设 `min-w-fit`）；或者在 `@xl/header` 以下隐藏右侧的「已自动保存」文字，只留图标。修完重跑这个 spec 的 light 和 dark |
| 严重程度 | 中。编号是任务的主标识，平板和窄窗口都会碰到；并且合并前 CI 的 browser 用例会是红的 |

### E2 打开没有权限或已删除的任务链接 → `getIssue` 返回 HTTP 500

| 项 | 内容 |
|---|---|
| 页面 | `/?issue=<id>`。场景：peer 打开 owner 的私有任务，或者任何过期、无权限的链接 |
| 操作 | 打开链接；或点「重新读取」 |
| 现象 | 界面正确显示「任务不可用 / 任务可能已删除，或你没有访问权限」，但 server action 返回 500，浏览器控制台报 `Failed to load resource: 500`，服务端日志打印 `⨯ Error [ActionFailureError]: issueNotFound` 和堆栈。每点一次「重新读取」都再报一次 |
| 错误信息 | `500 POST /mikka?issue=…`（Next-Action = `getIssue`，用 server-reference-manifest 对出来的） |
| 截图 | `shots-browser/E2-peer-private-issue-500.png` |
| 原因 | `app/actions/issues.ts:79-80`：`getIssue` 没有包在 `runAction` 里，直接调 `requireIssueAccess`；后者在 `lib/issue-access.ts:21` 抛出 `ActionFailureError('issueNotFound')`，被 Next 当成未处理异常返回 500 |
| main 上有吗 | **有，早已存在**。这两个文件在 overnight 里都没改过，main 的 `getIssue` 一字不差 |
| 建议修法 | 把 `getIssue` 用 `runAction` 包起来，返回 `{ error: 'issueNotFound' }`，客户端走现有的「任务不可用」分支。这样日志和告警里不会再出现预期之内的 500 |
| 严重程度 | 低到中（发生概率 5 × 影响 3）。界面没问题，但每个失效的链接都会产生一条 500 和一条控制台错误，会污染错误监控。按 AGENTS 的分诊规则，可以开 issue 跟进，不急着在本 PR 修 |

## ⚠️ 没反应 / 体验问题

| # | 页面 / 操作 | 现象 | 原因（file:line） | main 上有吗 | 建议 | 严重程度 |
|---|---|---|---|---|---|---|
| W1 | 看板 → 「新建任务」（**生产默认开关**） | 弹窗能打开，但「创建任务」一直是灰的，只提示「这个工作区还没有开启任务创建，可以先在对话里交给 Coordinator。」。看板工具栏上最显眼的按钮在生产里是死路；弹窗里还显示着绿色在线的「E2B」 | `components/coordinator/new-task-dialog.tsx:62,143,146`（`issueCreationAvailable()`，即 `MIKKA_ISSUE_TOOLS_ENABLED`） | **overnight 新加的门禁**（main 上能发送） | 开关关闭时直接隐藏或禁用看板上的「新建任务」，或者让它跳到 Coordinator 对话；弹窗里不要再显示 E2B 选择 | 中 |
| W2 | 主页 / Bot 对话发消息；看板「新建任务」（开关全开时）提交 | 消息出现在对话里，然后什么都没有：没有「正在思考」，没有失败提示，也不会建出任务。开关全开时「新建任务」会转成「帮我新建一个任务（在 E2B 上做）：…」发给 Coordinator，弹窗关掉，没有 toast | `lib/coordinator/wake.ts:17,46`：`coordinatorEnabled()` 为 false 时 `wakeCoordinator` 直接 return。`app/actions/coordinator.ts:73` 的 `sendCoordinatorMessage` 不检查这一点（而 `sendSuggestion` 会检查） | 早已存在。本机没有模型、没有 `AI_GATEWAY_API_KEY`，生产不会是这样，但部署漏配时用户看不到任何反馈 | 和 `sendSuggestion` 一样：Coordinator 不可用时拒绝发送，或在对话里显示「未连接」 | 低（环境相关） |
| W3 | 看板 → 刷新 / 直接打开链接 | 点 rail 的「看板」后 URL 还是 `/mikka`；刷新会回到主页对话，看板和列表视图都没了；看板没法分享链接 | `components/workspace/issue-workspace.tsx:348`（`navigateSection('all-issues')` 不写进 URL）。`app/[locale]/page.tsx:23` 的 `initialSection` 白名单里没有 `all-issues` | 早已存在 | 把 `section=all-issues`（以及 layout）写进 URL，并加进白名单 | 低到中 |
| W4 | 看板工具栏的绿色 ⟳ 图标 | 不管工作区有没有接 Linear，都显示绿色的「已与 Linear 同步」。实际点下去只是重新拉一次本地数据 | `components/workspace/board-page.tsx:203` | 早已存在 | 没接 Linear 时把文案改成「刷新」并去掉成功色，或者干脆不显示 | 低 |
| W5 | 创建工作区，名称填纯中文或「QA 第二工作区」 | 自动生成的网址是空的，或只有 `qa`（少于 3 位），「创建工作区」变灰，或者弹出浏览器原生的「Please match the requested format」。用户必须自己想一个网址 | `components/workspace/create-workspace-form.tsx:44`：slug 只保留 `[a-z0-9]`，非拉丁字符全被丢掉 | 早已存在 | 生成结果不足 3 位时补上随机后缀（例如 `ws-xxxx`） | 低 |
| W6 | 设置 → 团队（英文界面） | 搜索框的无障碍名称是 "Could not save the team. The identifier may already be in use…"，读屏会念出一句错误提示 | `components/teams/team-directory.tsx:86` 用的是 `FeatureCopy.c_997ba91d`，而 `messages/en.json:2279` 里这个 key 的英文是一句错误提示（中文是「搜索团队」） | 早已存在 | 换成一个专用的「搜索团队 / Search teams」key | 低（无障碍） |
| W7 | 插件 → 技能 tab | `GET /api/skills/search` 返回 503，控制台报错。界面有降级：「暂时无法加载 skills.sh 技能目录」，并提供重试和外链 | `app/api/skills/search/route.ts:22-26`：本机没有 Vercel OIDC token | 环境问题（main 一样）。界面降级是对的 | 不用修；只是 503 也会进控制台，监控时要注意 | 低（环境） |
| W8 | 线程 → 「停止」 | 显示「正在停止… / 停止未确认 / 重试停止」，run 一直是 running | 没有 daemon 确认停止。这是设计行为，`thread-stop.spec.ts` 已通过 | 环境问题 | 无 | 信息 |
| W9 | `/device` 输入无效码 | 正确显示「验证码无效或已过期」，但控制台多一条 `400 GET /api/auth/device?user_code=…` | Better Auth device 接口的正常 400 | 早已存在 | 可以忽略 | 信息 |
| W10 | Factory：任务经 `POST /api/factory/tasks/route` 路由成功（200，stage=execute，status=pending）之后 | 任务详情页上看不出这个任务已经进了 Factory。只有到 approval 或 publish 阶段才会出现「技能验收」 | `components/workspace/factory-acceptance.tsx:103` 只筛 approval 和 publish 阶段 | overnight 新功能，属于设计取舍 | 如果希望用户知道「已进 Factory」，可以在 execute 或 review 阶段也加一个只读的状态条 | 信息 |
| W11 | 设置 → 常规（管理员） | 名称和工作区 ID 都是只读，管理员也不能在设置里改工作区名（页面有说明） | 设计如此 | — | 如果要支持改名，需要另开需求 | 信息 |

## 误报说明（爬虫标成「没反应」或「超时」，人工复核后判为 ✅）

- 通知、记忆页面每个开关旁边都有一个「checkbox ""」点不到：那是 Base UI Switch 自带的隐藏原生 input（`aria-hidden`、`tabindex=-1`）。开关本身是通的：关掉后刷新仍是关的。
- 任务详情、成员、团队页的「textbox ""」点不到：同样是 Base UI Select 的隐藏 input。
- 「添加文件」「更换（头像）」没反应：会打开系统的文件选择器（`<input type=file>`）。
- 产物「全部」、活动「全部」、偏好「简体中文」、通知「立即」没反应：点的是当前已选中的选项。
- 偏好「前缀」打字没反应：最多 4 个字母，`TEST` 已经占满。
- 常规「名称 / 工作区 ID」打字没反应：只读，页面有说明。
- 新建工作区的「工作区数据区域」打字没反应：只读，只有一个区域可选。
- 登录、注册空表单提交没反应：浏览器原生必填校验拦下了。
- 主页「新建 Bot」超时：爬虫之前把侧栏收起了，按钮被遮住。复核时弹窗能打开，填名字创建成功，Bot 出现在列表里。
- 「上一个任务」超时：同样是遮挡。复核时 prev/next 可用，URL 会切换。
- 搜索面板里的「详情 / 线程 / PR」tab 超时：被搜索面板盖住了。复核时用回车或点结果都能跳到任务。

## 关键流程复核（两轮结果相同，除非另有说明）

| 流程 | 结果 |
|---|---|
| 邀请成员 → 生成链接 → peer 接受 → 成为 member | ✅ |
| 新建 Bot（弹窗 → 填名字 → 创建） | ✅ |
| 打开线程卡片 → 线程视图（概览 / 全部线程 / 详情 / 线程 / PR / 产物） | ✅。没有出现「电脑」tab，因为这个 run 没有绑定电脑 |
| 线程「停止」 | ⚠️ 见 W8（环境问题） |
| 任务：改状态（DB 里变成 doing）、上一个/下一个、评论、收藏（有 toast）、更多菜单（21 项）、团队选择 | ✅ |
| 全局搜索（Ctrl K）→ 输入 → 回车或点结果 → 打开任务 | ✅ |
| 看板 ↔ 列表切换；列表里点行打开任务 | ✅ |
| 看板「新建任务」 | 默认开关下 ⚠️ W1；开关全开时能发出去，但没有 Coordinator，见 W2 |
| 新建项目弹窗 | ✅ |
| 账户改名并保存（DB 已更新） | ✅ |
| 修改密码，输错当前密码 | ✅ 提示「当前密码不正确。」 |
| 主题切到深色再切回；语言切到 English | ✅ |
| 通知开关保存后刷新仍保留 | ✅ |
| 连接页「刷新状态」 | ✅ 发出 server action |
| 数据与隐私「导出」 | ✅ 邮件服务不可用时退回为直接下载链接 |
| 成员：管理 peer 菜单（设为管理员 / 停用）、导出 CSV（下载 members.csv） | ✅。没有真的去停用 |
| 团队：创建团队页 → 标识符自动生成 → 创建 → 跳到团队详情 | ✅ |
| 新建工作区（手动填网址）→ 进入新工作区；工作区菜单 | ✅（自动网址见 W5） |
| peer：成员页「邀请成员」灰掉、仍可导出 CSV；团队权限页只看到标题；看不到 owner 的私有任务 | ✅（500 见 E2） |
| `/acceptance` | 404，符合预期（只在 development 下启用） |
| `/settings?section=billing`（未构建的分区） | 落到「偏好设置」，符合 `lib/settings-sections.ts` 的设计 |
| 匿名访问：登录、注册、忘记密码、重置密码、验证邮箱、错误的邀请 token | ✅ 页面都能正常渲染，没有报错 |
| 移动端 390 宽：主页、项目、任务详情、设置 | ✅ 无溢出、无报错（`shots-browser/mobile-390-sheet.png`） |
| Dark：主页、看板、任务详情、设置 | ✅ 渲染正常（`shots-browser/dark-sheet.png`） |

overnight 自带的浏览器用例（开关全开，`E2E_BASE_URL=http://localhost:3100`）：

| 文件 | 结果 |
|---|---|
| `factory-acceptance-ui.spec.ts`、`factory-acceptance-a2.spec.ts` | ✅ |
| `credential-login-card.spec.ts` | ✅ |
| `e2b-machine-name.spec.ts` | ✅ |
| `thread-question.spec.ts` | ✅ |
| `subagent-login-needs.spec.ts` | ✅ |
| `thread-stop.spec.ts` | ✅ |
| `settings-surface.spec.ts` | ✅ |
| `coordinator-choice-card.spec.ts` | ✅ |
| `issue-header-breadcrumb.spec.ts` | ❌ 宽度扫描 light 和 dark 都失败（见 E1）；录屏用例失败是因为缺 ffmpeg（环境问题）；折叠菜单的两个用例通过 |

这几个 Factory 用例是用 `page.route` 模拟服务端返回的，只证明验收窗口的 UI 和按钮能用，不证明真实的 Factory 流水线能走到 approval。真实路由 API 我单独测过，返回 200（见 W10）。

## 未测 / 跳过与原因

- **破坏性操作，没有点**：退出登录、删除账户、删除任务、停用成员、撤销邀请、移除筛选、解散或离开团队。
- **外部或付费，没有点**：所有「连接」按钮（Gmail、Google Calendar、Notion、Slack、Linear，走 Composio OAuth）、关联 Google、GitHub、Stripe 和订阅、发送验证邮件或重置邮件。本机也没有对应的服务端配置。
- **真实模型回复**：没有 Coordinator 和模型凭据，Bot 不会回复，所以对话卡片、Coordinator 自己建任务、Factory 真实流转都没测。
- **真实 daemon 或电脑**：线程的「电脑」tab、截图、停止确认、BYO E2B（代码里写死为关闭）都没测。
- **Factory 验收窗口的真实数据**：要走完 execute、review、verify 才能到 approval，本机做不到。只用 overnight 自带的模拟用例验证了 UI。
- **个人邮箱、个人写入**（`MIKKA_PERSONAL_MAILBOX_ENABLED`、`MIKKA_PERSONAL_WRITES_ENABLED`）：需要接 Gmail，没测。打开这些开关后页面能加载，没有报错。
- **dark 只截图没点击**；移动端每页最多点 35 个控件。
- **环境差异**：用的是 PG 16 和 Node 22，CI 是 PG 17 和 Node 24。没有重新构建 main 做 A/B 对比，「main 上有吗」是按代码差异判断的。

## 文件

- `qa/shots-browser/`：上面引用的截图（E*、W* 是问题，ok-* 是通过的流程）。
- `qa/data/crawl-{default,flags}.json`：爬虫原始结果。里面引用的截图文件名只有一部分拷进了仓库。
- `qa/data/verify-{default,flags}.json`：人工复核脚本的结果。
- `qa/tools/`：一次性脚本（crawl、verify、bootstrap、prepare、serve）。路径写死为 `/root/qa`，只作复现参考，不属于产品代码。
