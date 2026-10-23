# Nav v3 导航与布局交接

状态：规格已确认，应用代码尚未按本文改动。确认人 Alex（产品负责人），日期 2026-10-23。本文只描述群聊主线的导航、右栏、看板和任务详情。设置、登录、设备、Telegram 的现有页面不在这次布局里重做。

本文分两部分。第一部分是交接规格，按区域写明已决定的行为、交互规则、明确不做的事、未决事项和验收清单。第二部分是实现提示词，可直接交给 Mikka Frontend agent 或编码 agent。提示词引用第一部分的章节号，并要求按增量 PR 落地。

未决事项：没有。下面每一节的「未决事项」都是「无」。不要把实现时的文件拆分当成产品问题重新打开。

## 设计来源

视觉与交互以这两份设计为准。本文用文字固定 Alex 已确认的行为；设计稿负责间距、图标和具体排布。两者冲突时，以本文的行为规则为准，并把视觉差异留在实现 PR 里对照设计稿调整，不要另写一套产品规则。

- 终稿（Nav v3，Design Lead）：<https://www.figma.com/design/mdvHHTfEnQmlOij4OOgw5F?node-id=42-890>
- 交互原型（PM 草图）：<https://www.figma.com/proto/zPe5LKycb2XuT1ivCLRw07/Mikka?node-id=1-2&starting-point-node-id=1%3A2>

## 代码地图

下面都是仓库里已经存在的路径。某一节说「新的」，就是仓库里还没有对应界面或类型，实现时要新做，不要假装已经有文件。

| 用途 | 已有路径 | 与 Nav v3 的关系 |
| --- | --- | --- |
| App Router 与语言壳 | `app/[locale]/layout.tsx`、`app/[locale]/page.tsx`、`i18n/routing.ts`、`i18n/request.ts`、`i18n/navigation.ts` | 工作区仍从 `app/[locale]/page.tsx` 进入 `IssueWorkspace`。语言为 `zh-CN`（默认）和 `en`，前缀 `as-needed`。 |
| 当前工作区壳 | `components/app-shell.tsx`、`components/ui/sidebar.tsx`、`components/app-sidebar.tsx`、`components/workspace/issue-workspace.tsx`、`components/workspace/workspace-navigation.ts` | 今天是「侧栏 + 一块主内容」。三栏是新的布局。`WorkspaceSection` 今天包含收件箱、我的任务、Agent、Coordinator、项目、视图、团队、插件等，比主线左栏宽。 |
| Agent 会话 | `components/workspace/agent-panel.tsx`、`components/workspace/agent-chat.tsx`、`components/workspace/agent-composer.tsx`、`components/agents/prompt-input.tsx`、`lib/db/schema.ts` 的 `agent_sessions` | 中栏里的 Agent 会话复用这些。左栏要列出会话，是新的列表呈现。 |
| 编排者 | `components/coordinator/coordinator-chat.tsx`、`app/actions/coordinator.ts`、`app/api/coordinator/messages/route.ts`、`components/workspace/workspace-overview.tsx` | Coordinator 就是规格里的编排者。今天它占满主内容，不是中栏里的一席。预填输入是新的。 |
| 群聊 | 无 | 新的。源码里没有群聊类型、页面或「群聊」文案。 |
| 主对话/群聊切换 | 无 | 设计稿里的旧控件。源码中不存在。不要新增。 |
| 插件页 | `components/plugins/plugins-skills-view.tsx`；侧栏入口在 `components/app-sidebar.tsx` | 已有「插件与技能」页（设备、集成、技能）。左栏小按钮是新的摆放。 |
| Mikka 自己的 MCP 服务 | `app/api/mcp/route.ts`、`docs/mcp.md`、`lib/mcp/` | 这是外部 Agent 连接 Mikka 的服务，不是左栏「插件」要打开的连接器目录。 |
| 输入区附加控件 | `components/agents/prompt-input.tsx`、`components/workspace/agent-composer.tsx`、`components/workspace/agent-starters.tsx` | 今天有模型选择（调用处传入 `DS 4.1 Flash`）和 starter 动作菜单。源码里没有 Upload Notes、Styles、AI Model 这三枚芯片。 |
| 看板 | `components/workspace/issue-board.tsx`、`components/blocks/kanban-board-1/components/kanban-board.tsx`、`components/reui/kanban.tsx` | 拖拽改状态已经调用 `moveIssue`。今天看板是任务列表上的一种视图（`issue-workspace.tsx` 里的 `layout === 'board'`），不是左栏以右的整页。 |
| 任务标识 | `issueIdentifier`，`components/workspace/issue-properties.ts` | 现有编号是 `ORV-{number}`。 |
| 任务详情 | `components/workspace/task-detail.tsx`、`components/workspace/issue-detail-header.tsx`、`components/workspace/issue-editor.tsx`、`components/workspace/issue-activity.tsx`、`components/workspace/issue-activity-feed.tsx`、`lib/issue-activity.ts` | 今天选中任务会换掉整块主内容。面包屑是「工作区 › 任务 › 编号」，不是「看板 › id」。评论线程和活动时间线画在同一块 `IssueActivity` 里。 |
| Agent 运行 | `lib/agent-runs.ts`、`agents` / `agentRuns`（`lib/db/schema.ts`）、`RUN_STATUSES` | 运行可以挂在 `agentRuns.issueId` 上。评论面板里的「打开会话」条目，以及详情页右侧的会话条，是新的。活动时间线的事件种类里没有 run。 |
| 指派 | `lib/issue-metadata.ts` 的 `assignee.kind`：`member` 或 `agent` | 没有单独的「Agent 创建者」列。 |
| Linear | `app/api/webhooks/linear/route.ts`、`lib/linear-sync/`、`lib/linear-sync/dispatch.ts`、`docs/linear-sync.md`、`app/actions/issues.ts`、`app/actions/issue-metadata.ts`、`app/actions/collaboration.ts`、`app/actions/linear-sync.ts` | 双向同步已经存在。看板和详情继续走这些写入，不要做只读镜像，也不要新写一套同步协议。 |
| 右栏五个标签、内置浏览器、知识库、用户侧定时任务 | 无 | 新的。`app/api/cron/linear-sync/route.ts` 是 Linear 同步的恢复 cron，不是「定时任务」标签。 |
| 滑动药丸 | `components/motion/shared-layout-bg.tsx` | 这是悬停高亮，不是右栏标签。标签的滑动变宽是新的，而且是整个主线里唯一的动画。 |
| 文案 | `messages/zh-CN.json`、`messages/en.json` | `Issue.status.doing` 已是「进行中」。`Nav.plugins` 已是「插件」。`Nav.coordinator` 已是「Coordinator」。五个标签名、面包屑、只看我的、已与 Linear 同步、打开会话都要新增 key。 |
| UI 与 i18n 门禁 | `ui-policy.json`、`scripts/lint-ui.mjs`、`scripts/ui-policy.mjs`、`scripts/interaction-policy.mjs`、`scripts/settings-policy.mjs`、`scripts/check-i18n.mjs`、`.github/workflows/ui-policy.yml` | 实现 PR 必须通过这些检查。本文不改它们。 |

# 第一部分 交接规格

## 1. 原则

### 已决定

克制。只做群聊主线需要的东西。每个能力一个入口。界面上不放解释性填充文案。

### 交互规则

用户能点的地方就进入那个能力本身。空数据时面板可以是空的，仍然必须能点开。不要用一段说明告诉用户这个区域是做什么的。

### 明确不做

不为主线增加第二入口，例如详情里再放一块插件、左栏再放一排团队图标、看板再嵌进右栏。不写引导文案、功能介绍、空态长说明。不在这次布局里重做设置、登录、设备或 Telegram。

### 未决事项

无。

### 验收清单

- [ ] 主线上每个能力只有规格里写明的那一个入口。
- [ ] 界面文案是对象本身的名字或状态，没有解释性段落。
- [ ] 没有「即将推出」「敬请期待」或只打印日志的按钮。

## 2. 三栏

### 已决定

工作区主线是三栏。

- 左栏：Agent 与群聊列表，参照 Grok Bot 的列表密度。另外有两个分开的小按钮：看板、插件。插件指 MCP connectors。
- 中栏：只显示左栏当前选中的那一个会话。会话是某个 Agent、编排者（Coordinator），或一个群聊。
- 右栏：带标签的面板，可以用 ⤢ 加宽到左栏以右的全宽。

编排者就是现有的 Coordinator，界面名称继续用 `Nav.coordinator`（「Coordinator」），不要新做一个同功能的聊天组件。

### 交互规则

左栏点一条会话，只有中栏换成该会话。右栏的当前标签、标签内容和已经打开的任务线程都保持不动。例外在第 6 节：右栏正停在「详情」时，详情内容跟着新会话走。

看板按钮打开第 8 节的整页看板，不是右栏里的一页。插件按钮打开插件，不是详情里的一节。

中栏只渲染当前会话。不要在中栏下面再挂任务列表、看板或详情。

群聊是新的。没有真实群聊记录时，左栏不要放假的群聊行。已有数据先接上：Agent 会话来自 `agent_sessions` 与 `components/workspace/agent-panel.tsx`，编排者来自 `components/coordinator/coordinator-chat.tsx`。

### 明确不做

不把今天 `components/app-sidebar.tsx` 里的收件箱、我的任务、项目、视图、团队轨道、设备原样留在主线左栏。这些页面的路由和数据保留：`app/[locale]/settings/`、`app/[locale]/devices/page.tsx`，以及现有项目与团队设置。不要在本规格里删掉它们，也不要为它们新做一套信息架构。

账户菜单沿用 `components/workspace-menu.tsx`，不要把它变成会话列表里的一行，也不要再复制一个设置入口。

不新增拖拽改变三栏宽度。栏宽只由 ⤢ 改变（第 4、5 节）。`components/ui/resizable.tsx` 已存在，本规格不用它做栏宽拖拽。

不新增源码里不存在的「主对话 / 群聊」切换。

### 未决事项

无。

### 验收清单

- [ ] 左栏是会话列表，加上看板、插件两个小按钮。
- [ ] 中栏只显示当前选中的 Agent、Coordinator 或群聊。
- [ ] 切换左栏会话时，右栏标签和已打开的任务线程不变；只有「详情」的内容跟随。
- [ ] 没有团队轨道图标，没有主对话/群聊切换，没有假的群聊行。

## 3. 右侧标签

### 已决定

右栏恰好五个标签，顺序固定：详情、任务、浏览器、知识库、定时任务。

当前标签是「图标 + 文字」的药丸。其余标签只显示图标，徽章仍留在图标上。药丸会滑动并变宽。这是整个主线里唯一的动画（第 4 节）。

旧的「主对话 / 群聊」切换去掉。源码里没有这个控件，实现时不要加出来。

### 交互规则

点一个标签，只有右栏内容切换，而且是立刻切换。中栏不动。左栏不动。

从左栏换会话时，右栏停在原来的标签上，标签里的内容和已打开的任务线程都保留。右栏若正停在「详情」，详情改成新会话的信息，标签本身仍是「详情」。

徽章用 `components/ui/badge.tsx`。只在该标签已有真实数量时显示，不造演示数字，也不新做一套统一通知系统。没有数量时不显示假徽章。

「知识库」和「定时任务」遵守同一套标签规则。仓库没有知识库页面，也没有用户侧的定时任务产品。`app/api/cron/linear-sync/route.ts` 不是这个标签。这两个标签是新的：必须能点开，面板里只放真实数据；没有数据时就是空的，不写说明，不放示例条目。本规格不定义它们的内部流程，实现时不要自行加一套知识库或日程产品。

「浏览器」的内部行为见第 7 节。「任务」见第 5 节。「详情」见第 6 节。

### 明确不做

不增加第六个标签，不恢复主对话/群聊切换，不把标签切换做成整页过渡。不把 Linear cron、Coordinator 的 memory（`docs/mcp.md` 里的 `read_coordinator_memory`）改名成这两个标签。不在标签页里放解释性空态。

### 未决事项

无。

### 验收清单

- [ ] 标签正好五个，顺序为详情、任务、浏览器、知识库、定时任务。
- [ ] 当前项是图标加文字的药丸，其余只有图标；有真实数量时徽章还在。
- [ ] 切换标签只更换右栏，中栏保持当前会话。
- [ ] 知识库和定时任务能点开；没有数据时为空，没有假内容和说明文案。

## 4. 动效

### 已决定

主线里没有任何全屏过渡或页面过渡。每一次导航都是立刻完成。

唯一动画是右栏当前标签药丸的滑动和变宽。

切换标签只改变右栏。切换左栏会话只改变中栏。右栏保持标签、内容和已打开的任务线程。右栏正停在「详情」时，详情内容跟随新会话。

### 交互规则

药丸动画只发生在右栏标签条上。加宽右栏、打开看板、打开任务详情、打开会话条，都不要伴随滑入页面或淡入整栏。

`components/motion/shared-layout-bg.tsx` 是悬停高亮药丸，不是这五个标签。不要直接把它当成标签状态。标签药丸是选中态。实现动画时复用仓库已有的 `motion` 和 `useReducedMotion`（`components/agents/prompt-input.tsx`、`components/motion/shared-layout-bg.tsx` 已这样写）。系统开启减少动态效果时，药丸直接出现在新标签上，不滑动。这仍是同一处反馈，不是第二种动画。

`lib/ease.ts` 的 `SPRING_LAYOUT` 可以给这一个药丸使用。不要同时启用该文件里的面板进入弹簧（`SPRING_PANEL`）来做换页。

`app/[locale]/loading.tsx` 是路由加载占位。不要把它扩成页面过渡。`pnpm test:motion` 覆盖的是 `lib/message-navigation.ts` 的文本导航，不是这颗药丸；改药丸时不要改坏该测试。`tests/e2e/navigation-performance.spec.ts` 要求导航和 Agent 内容在 1000ms 内就绪，即时切换与它一致。

### 明确不做

不给中栏、左栏、看板、任务详情、会话条加进入、离开或共享元素转场。不在标签切换时让右栏淡入。悬停高亮药丸上的模糊进入（`shared-layout-bg.tsx` 的 blur variants）不要用到这五个标签上。

### 未决事项

无。

### 验收清单

- [ ] 换标签、换会话、打开看板和打开详情都没有页面过渡。
- [ ] 肉眼可见的动画只有标签药丸的滑动和变宽。
- [ ] 减少动态效果时，标签切换仍然立刻完成，药丸不滑动。

## 5. 任务标签

### 已决定

右栏「任务」上面是建议卡片，下面是任务分组。它们在同一个滚动区域里一起滚动。

悬停一张建议卡片时出现 ＋。点 ＋ 之后，中栏切到编排者，并把该任务预填进编排者的输入框。

在中栏发送后，这次派发生效：右栏「进行中」下面出现一张新的线程卡片，对应的建议卡片消失。

点一张线程卡片，整个右栏换成该线程的对话。标签条变成面包屑「任务 › <任务名>」，同一行上有 ✓、⋯、⤢、✕。只有 ⤢ 加宽右栏。

线程对话里的任务卡片是平的，没有边框，和列表行一样。

### 交互规则

建议和分组共用一个滚动容器，不要做成上下两个嵌套滚动框。

＋ 是建议卡片上的动作，点的是 ＋，不是把整张卡片做成链接。点了之后只改中栏：会话变为 Coordinator，输入框带上这条建议的任务文本。右栏仍留在「任务」。预填是新的。`CoordinatorChat` 今天把草稿放在组件内部状态里，没有预填参数；给它加上这个能力，不要另写一个编排者。

发送走已有的 `sendCoordinatorMessage`（`app/actions/coordinator.ts`）。发送成功后，右栏「进行中」增加该线程卡片，该建议从列表消失。文案「进行中」复用 `Issue.status.doing`，不要在组件里写死中文。

这里的「进行中」是右栏里的任务线程分组，不是看板上的那一列。看板列仍用 `ISSUE_STATUSES`（`components/workspace/issue-properties.ts`）。若这次发送已经产生 issue 或 run，线程卡片指向那条已有记录（`lib/agent-runs.ts` 的 `issueId`，或现有 issue）。仓库里没有 `task_threads` 一类的表，不要在实现说明里假装有。还没有可列出的记录时，线程列表是新的界面状态，落到已有的 issue 或 run 上，不平行新造一套任务存储。

点线程卡片会替换整个右栏，中栏保持不变。面包屑上的四个控件都必须是真实按钮：

- ⤢ 在「右栏原宽」和「左栏以右的全宽」之间切换。全宽时右栏盖住中栏所占的区域，中栏会话不卸载。收回后中栏仍是原来的会话。没有页面过渡。
- ✕ 关闭线程视图，右栏回到「任务」标签，列表和滚动位置还在。中栏不变。
- ✓ 把这条线程标为完成，使它离开「进行中」。线程若对应一条 issue，走 `moveIssue`（`app/actions/issues.ts`）把状态写成 `done`。
- ⋯ 只打开这条任务已经有的操作（现有动作在 `components/workspace/issue-detail-actions.tsx`）。没有对应操作时不渲染空菜单。

线程对话内部出现的任务卡片不加边框，悬停和选中只改变背景，与 `components/workspace/issue-list.tsx` 的行一致。

### 明确不做

不用线程卡片上的 ✓、⋯、✕ 去加宽右栏。不把建议卡片和分组拆成两个滚动区域。不新写编排者。不把右栏分组和看板列合成一个新的状态枚举。不为 ⋯ 发明一套新菜单信息架构或说明文字。

### 未决事项

无。

### 验收清单

- [ ] 建议在上，分组在下，两者一起滚动。
- [ ] 悬停建议出现 ＋；点 ＋ 后中栏是 Coordinator，输入框已有该任务文本。
- [ ] 发送后「进行中」出现线程卡片，该建议消失。
- [ ] 点线程卡片后，右栏变为该线程对话，面包屑为「任务 › <任务名>」，四个控件都可点，只有 ⤢ 改变栏宽。
- [ ] 线程对话里的任务卡片没有边框。

## 6. 详情标签

### 已决定

「详情」显示中栏当前会话的信息。没有插件区。没有解释性文案。

### 交互规则

内容跟着中栏当前会话走：Agent 会话、Coordinator，或一个群聊。从左栏换会话时，若右栏停在「详情」，这里换成新会话的信息，标签不跳走。

只展示该会话已经有的事实，例如名称。Agent 会话的标题在 `agent_sessions`。Coordinator 是这个人的那一个对话（`getCoordinatorChat`）。群聊还没有记录，不编造成员介绍。

插件留在左栏小按钮。详情里不嵌入 `components/plugins/plugins-skills-view.tsx`。

### 明确不做

不在详情里放插件、技能、设备或集成。不写「这个面板用来……」一类说明。不把详情做成第二个任务详情页（任务详情是看板打开的整页，见第 10 节）。

### 未决事项

无。

### 验收清单

- [ ] 详情内容与中栏当前会话一致，换会话后跟着变。
- [ ] 详情里没有插件区，也没有解释性段落。
- [ ] 插件仍然只能从左栏小按钮进入。

## 7. 浏览器标签

### 已决定

「浏览器」是类似 Codex 的内置浏览器，是新的。用户点页面上的一个组件，对该组件发表评论，评论发到中栏当前会话。

### 交互规则

评论的目的地就是中栏当时打开的会话，不另开一条通道。

- 中栏是 Agent：写入该 Agent 会话（现有会话路径在 `components/workspace/agent-chat.tsx`，请求在 `app/api/agent/route.ts`）。
- 中栏是 Coordinator：走 `sendCoordinatorMessage`。
- 中栏是群聊：发到该群聊。群聊模型还不存在，浏览器评论不要先于真实群聊落地。

点选的是页面里的组件，评论进中栏。右栏留在「浏览器」。不要因为评论而切换标签或整页跳转。

仓库里没有内置浏览器组件。这是新界面。不要把 Playwright 测试（`tests/e2e/`）或 `docs/mcp.md` 里的 MCP 工具说成这个浏览器。

### 明确不做

不把评论发到一个与中栏无关的收件箱。不在浏览器页加使用说明。不在本文指定一个仓库里不存在的浏览器库。

### 未决事项

无。

### 验收清单

- [ ] 右栏可以打开内置浏览器并点选页面组件。
- [ ] 发出的评论出现在中栏当前会话里。
- [ ] 发评论不会切换右栏标签，也不会做页面过渡。

## 8. 看板

### 已决定

看板是唯一的规划界面。它是独立的整页：左栏以右的全部区域，永不放进右栏。

不按团队拆分。团队没有轨道图标。

顶栏只有一个「只看我的」开关。打开时包含：指派给我的、我创建的、以及我的 Agent 创建或拥有的。

承载卡片的列容器可以保留。这是「盒子套盒子」规则的例外（第 11 节）。

页面上有一条克制的提示：「已与 Linear 同步」。

### 交互规则

从左栏看板按钮进入。进入后面包屑和内容都在左栏以右，右栏标签条不出现。返回主线三栏是即时的，没有页面过渡。

现有看板实现留在 `components/workspace/issue-board.tsx`，拖拽已经调用 `moveIssue`。整页是新的摆放：今天它只是 `issue-workspace.tsx` 里列表/看板切换中的看板。优先继续用这块看板，而不是再写一个数据源不同的板。

「只看我的」用已有字段组合，不新增所有权列：

- 我创建的：`issues.userId` 是当前用户。
- 指派给我的：`lib/issue-metadata.ts` 里 `assignee.kind === 'member'` 且 id 是当前用户。
- 我的 Agent 拥有的：`assignee.kind === 'agent'`，且该 Agent 的 `agents.userId` 是当前用户。
- 我的 Agent 创建的：没有单独的创建者列。Agent 经 MCP `create_issue` 写入时，`docs/mcp.md` 写明走 `actAs`，任务的 `userId` 仍是这个人，因此落在「我创建的」里。与我的 Agent 的运行有关的任务用 `agentRuns.issueId`（`lib/agent-runs.ts`）纳入，Agent 须属于当前用户。

关闭开关时显示这块看板上的任务，仍然不按团队拆成多块板。团队数据、团队设置和 `app/actions/teams.ts` 保留，只是主线左栏不放团队图标，看板不按团队分轨。

提示「已与 Linear 同步」是新文案，放进 `messages/zh-CN.json` 和 `messages/en.json`。同步失败时不要继续显示成功。失败状态用已有的 outbox 错误（`app/actions/linear-sync.ts` 读取 `linearSyncOutbox` 里失败的记录）。提示保持一行，不附带说明段落。

列容器可以有边界，以便放下卡片。卡片本身仍遵守第 11 节：不在卡片里再套一圈盒子。

### 明确不做

不把看板嵌进右栏五个标签的任何一个。不按团队做多块看板，不在左栏恢复 `components/app-sidebar.tsx` 里的团队折叠菜单。不新增「只看我的」以外的顶栏筛选。不把提示写成同步原理说明。不新造所有权字段来实现这个开关。

### 未决事项

无。

### 验收清单

- [ ] 看板占据左栏以右的整页，右栏标签不可见。
- [ ] 左栏没有团队图标，看板不按团队拆分。
- [ ] 顶栏只有「只看我的」，范围覆盖指派给我的、我创建的、我的 Agent 拥有的。
- [ ] 列容器可以包住卡片；卡片内不再套盒子。
- [ ] 同步正常时显示「已与 Linear 同步」；失败时不显示成功。

## 9. Linear

### 已决定

双向同步已经存在：webhook 进来，编辑写回去。入口是 `app/api/webhooks/linear/route.ts`（校验后写入 `linearSyncInbox`，再 `dispatchLinearWebhook`）。写回经 `lib/linear-sync/dispatch.ts` 的 `dispatchLinearIssueSync`，由 `lib/linear-sync/` 处理。说明见 `docs/linear-sync.md`。

看板和任务详情在 Mikka 里可编辑。状态、指派人、标题、评论，以及拖拽卡片，都写回 Linear。没有只读模式。

### 交互规则

新界面继续调用已经会触发写回的函数，不要在前端直接调用 Linear API，也不要复制一份只展示、不保存的字段。

- 标题与状态：`saveIssue`、`moveIssue`（`app/actions/issues.ts`）。拖拽看板已经走 `moveIssue`。
- 指派人与其它元数据：`app/actions/issue-metadata.ts`。
- 评论：`app/actions/collaboration.ts`。评论同步实现在 `lib/linear-sync/comment-sync.ts`。

`docs/linear-sync.md` 已列出同步字段：标题、描述、状态、优先级、指派人、标签、截止日期，以及评论。删除不会双向删除。这些同步规则保持不变。本次只改导航和布局，不改同步协议。

详情和看板上的编辑控件必须真的保存。保存失败时沿用现有的 action 错误和 outbox 失败记录，不要改成静默只读。

### 明确不做

不把看板或详情做成 Linear 的只读投影。不新写 webhook 或 outbox。不在本规格里改变 `docs/linear-sync.md` 的字段映射、标签上限或删除语义。不把 `app/api/cron/linear-sync/route.ts` 做成用户可见的定时任务标签。

### 未决事项

无。

### 验收清单

- [ ] 在看板拖拽卡片会改变状态，并走 `moveIssue` 写回。
- [ ] 在详情修改状态、指派人、标题和评论会保存，并走现有的 dispatch。
- [ ] 没有把这些字段渲染成不可编辑。
- [ ] `lib/linear-sync/` 与 webhook 路由的协议没有被平行重写。

## 10. 任务详情

### 已决定

在看板上点一张卡片，打开整页任务详情。面包屑是「看板 › <id>」。

Agent 运行出现在评论面板里，作为一条带「打开会话」按钮的条目。它不出现在活动时间线上，这样别人仍可以给这个 Agent 留评论。

「打开会话」打开页面右侧停靠的 Agent 会话条。Agent 没在跑时也能打开。运行中显示一个绿点。会话条可以收起；再点一次「打开会话」会重新打开。底下的任务详情页保持可操作。

### 交互规则

整页的范围与看板相同：左栏以右的全部区域，不是右栏标签里的一页。从看板进入，返回看板是即时的。

`<id>` 使用现有 `issueIdentifier`（`ORV-{number}`，未编号时用现有的未编号文案）。不要新造编号格式。面包屑就是「看板 › <id>」。不要同时再放今天 `IssueDetailHeader` 那条「工作区 › 任务 › 编号」，也不要把该顶栏里的上一条/下一条带进新详情。那是旧顶栏，不是这次确认的界面。

评论和活动今天画在一起：`components/workspace/issue-activity.tsx` 同时接收评论线程和 `IssueActivityFeed`。活动事件由 `lib/issue-activity.ts` 的 `deriveIssueActivity` 产生，种类里没有 run。新行为是拆开呈现，而不是给时间线加一种 run 事件：

- 活动时间线保持现有事件种类。
- Agent 运行作为评论面板中的一条。数据来自 `lib/agent-runs.ts`（`agentRuns.issueId`）。按钮文案「打开会话」是新 key。
- 这条下面仍然可以写给人的评论，评论继续走 `app/actions/collaboration.ts`，以便 Linear 写回。

会话条是新的。它停靠在详情页右侧，不是模态框，不挡住详情的编辑。打开条件与运行状态无关。绿点在该 run 的 `status` 为 `running` 时出现（`lib/db/schema.ts` 的 `RUN_STATUSES`）。颜色用语义 token（例如 success），以便通过 `style/semantic-colors`；不要写 `green-500` 这类调色板类。再点「打开会话」时，若会话条已收起，就再次展开同一条会话，不新开一页。

会话内容复用已有的 Agent 会话或该 run 的消息（`RunDetail.messages`），不要再做一套聊天存储。

现有详情编辑（`components/workspace/task-detail.tsx`、`components/workspace/issue-editor.tsx`、属性与评论）保持可写，并继续第 9 节的写回。

### 明确不做

不把 Agent 运行画进 `IssueActivityFeed`。不用模态框盖住详情。不因为 Agent 没在运行就禁用「打开会话」。不新造任务编号。不把详情放进右栏「详情」标签（那是会话信息，第 6 节）。

### 未决事项

无。

### 验收清单

- [ ] 点看板卡片打开左栏以右的整页，面包屑为「看板 › ORV-编号」。
- [ ] 评论面板里有该任务的 Agent 运行和「打开会话」；活动时间线上没有这条运行。
- [ ] 运行条目下仍能发表评论。
- [ ] 会话条在 Agent 未运行时也能打开，运行中有绿点，可收起，再点按钮会重新打开，详情页仍可编辑。

## 11. 视觉

### 已决定

边框克制，参照 Grok Bot。不要盒子套盒子。看板的列容器除外（第 8 节）。

列表行没有边框。悬停和选中只改变背景。层级来自背景深浅和间距。浮层用阴影。

去掉输入区默认的 Upload Notes、Styles、AI Model 芯片。

用真实内容，不用占位。每个入口都可点击。

### 交互规则

主线列表（左栏会话、任务线程、线程内的任务卡片、看板卡片上的行信息）不加边框。悬停与选中用背景区分。分组用间距和背景色，不用横贯的分割线。这与现有 UI policy 的 `style/no-horizontal-rule` 一致：禁止 `border-b`、`border-t`、`divide-y` 和 `h-px` 的横线（`scripts/ui-policy.mjs`）。竖向的轻微边界不在此列。

「盒子套盒子」是本规格的视觉规则，不是一条已经存在的 lint 名。设置页另有规则：`docs/settings.md` 和 `scripts/settings-policy.mjs`。不要把设置页规则套到看板上，也不要为了主线去改设置页。

浮层（菜单、会话条、加宽后的右栏）用阴影分开层次，不靠再套一圈粗边框。

输入区：仓库里没有 Upload Notes、Styles、AI Model 这三个字符串。当前会话输入是 `components/agents/prompt-input.tsx`。`components/workspace/agent-composer.tsx` 会传入一个模型选项和 `components/workspace/agent-starters.tsx` 的动作。Nav v3 要求输入区不要出现那三枚默认芯片，不要为了对照设计稿把它们加进来。Coordinator 的输入今天是纯文本框（`components/coordinator/coordinator-chat.tsx`），保持没有这三枚芯片。

颜色、字号和间距继续走 `ui-policy.json`：语义色、预设排版、`gap` 而不是 `space-x` / `space-y`、不用单独的 `dark:` 颜色覆盖。图标用 `lucide-react`。可点击的东西用 `components/ui/button.tsx`（或策略允许的菜单、链接组件）。导航用 `i18n/navigation.ts` 的 `Link`。禁止空 `onClick`、`href="#"` 和「敬请期待」（`scripts/interaction-policy.mjs`）。

所有新可见文字同时写入 `messages/zh-CN.json` 和 `messages/en.json`，key 对齐，占位符一致。组件里不写死中文。检查是 `pnpm i18n:check` 和 `pnpm test:i18n`。

### 明确不做

不给列表行加边框。不在看板以外的地方用盒子套盒子。不新增 Upload Notes、Styles、AI Model。不用占位按钮顶替还没做的入口。不放宽 `ui-policy.json` 或 i18n 检查来迁就新界面。

### 未决事项

无。

### 验收清单

- [ ] 会话列表和任务行没有边框，悬停和选中只变背景。
- [ ] 除看板列容器外，没有盒子套盒子。
- [ ] 浮层用阴影，分组靠背景和间距。
- [ ] 输入区没有 Upload Notes、Styles、AI Model。
- [ ] 新文案在中英文消息文件里成对出现，界面上没有写死的中文。
- [ ] 每个画出来的入口都能点，并且会做规格里的那件事。

# 第二部分 实现提示词

把下面这一节整段交给 Mikka Frontend agent。它不依赖聊天记录。规格细节以第一部分为准；这里规定实现顺序和仓库约束。

---

你在 Mikka 仓库里实现 Nav v3 的导航与布局。先读 `docs/design/nav-v3-handoff.md` 第一部分第 1 节到第 11 节，以及文首的代码地图。设计终稿是 <https://www.figma.com/design/mdvHHTfEnQmlOij4OOgw5F?node-id=42-890> ，交互原型是 <https://www.figma.com/proto/zPe5LKycb2XuT1ivCLRw07/Mikka?node-id=1-2&starting-point-node-id=1%3A2> 。行为以交接文档为准。

这是已确认的规格，没有未决产品问题。不要扩大范围，不要把实现取舍写成新的产品问题。仓库里没有的界面，文档已标明「新的」。不要引用不存在的文件、表或组件。需要新界面时直接做，并在 PR 说明里写明它是新的。

用增量 PR，不要一次改完。建议顺序：

1. 三栏壳。左栏会话列表和看板、插件两个小按钮。右栏五个标签的药丸与即时切换。中栏先接上已有的 Agent 会话和 Coordinator。遵守第 1、2、3、4、11 节。
2. 任务标签：建议、＋、预填 Coordinator、发送、线程、面包屑和四个控件。遵守第 5 节。
3. 详情标签。遵守第 6 节。
4. 看板整页、「只看我的」、同步提示，以及从看板进入的任务详情和右侧会话条。写回继续走现有 Linear 路径。遵守第 8、9、10 节。
5. 浏览器标签。知识库和定时任务只做第 3 节写明的标签行为，不扩展内部产品。遵守第 7 节和第 3 节。

每一批 PR 只做该批的界面，并保持上一批仍可用。

仓库约束：

- 应用是 Next.js App Router。工作区入口是 `app/[locale]/page.tsx` 的 `IssueWorkspace`。优先沿用这个壳和现有 query（任务详情今天用 `?issue=`），不要平行造一套未接入 i18n 的路由。群聊、右栏、内置浏览器、知识库、用户侧定时任务是新的，文档代码地图已说明。
- 编排者复用 `components/coordinator/coordinator-chat.tsx` 和 `sendCoordinatorMessage`。插件按钮不要打开 `docs/mcp.md` 所描述的那个对外 MCP 服务；那个文件是 Mikka 自己的 MCP。插件页从 `components/plugins/plugins-skills-view.tsx` 延续，入口改到左栏小按钮。详情里不要再放插件。
- 看板拖拽、标题、状态、指派人、评论继续调用 `moveIssue` / `saveIssue`、`app/actions/issue-metadata.ts`、`app/actions/collaboration.ts`，从而走到 `dispatchLinearIssueSync`。不要做只读看板，不要新写同步协议。
- 「只看我的」按第 8 节的现有字段组合，不新增数据库列。
- 活动时间线不要加入 Agent 运行。运行放在评论面板，按钮为「打开会话」，会话条按第 10 节停靠在详情右侧。
- 唯一动画是右栏标签药丸的滑动和变宽。其余导航立刻完成。减少动态效果时用已有的 `useReducedMotion`，药丸不滑动。不要用 `SharedLayoutBg` 的悬停模糊动画当标签。
- 视觉遵守第 11 节，并保持现有门禁通过：`pnpm test:ui-policy`、`pnpm lint:ui`、`pnpm test:i18n`、`pnpm i18n:check`。相关规则包括 `style/semantic-colors`、`style/no-horizontal-rule`、`style/no-dark-color-override`、`style/gap`、`typography/preset-only`、`interaction/use-button-component`、`interaction/no-dead-control`、`interaction/no-placeholder-action`、`interaction/no-placeholder-link`。设置页规则（`docs/settings.md`、`scripts/settings-policy.mjs`）继续只约束设置页。
- 新文案写入 `messages/zh-CN.json` 和 `messages/en.json`，key 与占位符对齐。组件通过 `next-intl` 读取。链接用 `@/i18n/navigation` 的 `Link`。不要在可达的 UI 里写死中文。
- 不要新增 Upload Notes、Styles、AI Model 芯片。源码里现在没有这三枚。
- 不要恢复主对话/群聊切换，不要给团队加轨道图标，不要把看板放进右栏。
- 运行时验收按 `docs/acceptance.md` 和 `AGENTS.md`：在冻结的云端 Preview 上看已部署的版本，用 Google 或 GitHub 登录。不要在开发者的 Mac 上起服务或跑 `tsgo`。类型检查和 UI policy 走远程 CI（`.github/workflows/ui-policy.yml`）。
- 每个实现 PR 交接分支名、commit SHA 和该次 Preview 的唯一 URL。

完成标准是第 1 节到第 11 节的验收清单都能在 Preview 上点通，并且上述检查通过。
