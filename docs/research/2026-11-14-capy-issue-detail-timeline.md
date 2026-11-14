# Capy 0.8.0 issue 详情与时间线，以及怎么对齐

日期：2026-11-14。读者是要改任务详情活动区的人。读完可以按下面三步改，并知道哪些差别不能直接搬。本文不是决定，不改 `docs/design/decisions/` 或 `docs/design/rules.md`。

## 看过什么

- 安装包：`https://capy.ai/download/linux/x64/targz` 跳到 `https://downloads.capy.ai/stable/capy-0.8.0-x64.tar.gz`（161 105 216 字节，S3 `Last-Modified` 2026-11-11 00:09:19 UTC）。渲染进程在 `resources/renderer/`。`bundle-report.md` 写构建 `fe890a8c10f32d877049c0edc1e103925063ad78`，profile `desktop`，channel `stable`。
- 页面源码标记在 `resources/renderer/assets/index-BNVriEhx.js` 和 `issue-page-UDleuCCW.js`：`features/issues/issue-page.tsx`，`shared/issues/issue-view.tsx`（`PropertyRows`、`Description`、`SubIssuesSection`、`IssueActivity`、`CommentCard`）。详情主体把标题、属性、描述、子任务、活动放在 `max-w-3xl` 的一列里，间距 `gap-8`。活动组件把 `comments`、`timeline`（没有则用 `events`）和 PR 的打开/合并合成一条按时间升序的列表。
- 公开接口：[List issue timeline](https://docs.capy.ai/api-reference/issues/list-issue-timeline.md)、[Get issue](https://docs.capy.ai/api-reference/issues/get-issue.md)、[List issue comments](https://docs.capy.ai/api-reference/issues/list-issue-comments.md)。事件种类与安装包里的文案函数一致。
- Mikka：公开投影 `lib/issue-activity.ts`、`lib/task-activity-timeline.ts`、`lib/task-activity-versions.ts`，数据装配 `components/workspace/task-detail-frame.tsx`，契约 `components/slots/task-detail-contract.ts`。画面在私有 `mikka-hosted-ui` 的 `slots/task-detail.tsx`（`Activity`、`LogEntry`）。工作区标签的顺序已经按 [2026-11-10-1317](../design/decisions/2026-11-10-1317-capy-sidebar-and-task-layout.md) 排成标题、编号与时间、属性、描述、子任务、活动。

## 他们的详情页实际怎么排

顶栏是 `Issues / 父任务 / 编号与标题`。找不到或无权时是「Issue not found」。

正文一列，从上到下：

1. 标题是 `h1`（`text-xl font-medium`），下面一行是编号和创建时间。这个包里的标题块没有输入框。
2. 属性行：状态、优先级、截止日期、负责人、标签、创建者、PR、线程、关系、父任务，以及谁可以看见。
3. 描述默认是渲染好的正文。「Describe this issue」进入编辑，保存或取消。保存失败的文案是 `Could not save the description`。
4. 有子任务才出现 Sub-issues，带已关闭计数。
5. Activity。筛选在标题同一行：All、Comments、Agents & bots。默认只画最近 50 条，更早的用 `Show N earlier` 每次再揭 50 条。评论框在列表下面，占位 `Leave a comment`，回复占位 `Reply to {name}`。

活动一条时间线，旧的在上。三种行：

| 行 | 画面 | 来源 |
| --- | --- | --- |
| 字段变更 | 小图标加一句，时间在同一行 | `timeline` 事件 |
| 评论 | 卡片。回复缩在同一张卡片里，带 `Reply` | `comments`，用 `parentCommentId` 归组 |
| PR | `Opened owner/repo#n 标题` 或 `Merged …` | `pulls` 里 `viaCode` 为空的打开时间与合并时间 |

未读从 `viewer.unreadSince` 起，在第一条不早于该时刻的行前插一条分隔。正在发送的评论先出现，服务端评论到达后撤掉。作者可以是用户或线程：线程显示 Captain 名或线程编号，并链到 `/thread/$threadId`。

字段变更的句子（安装包里的文案函数）是：

- `{人} created {编号}`
- `{人} moved {编号} to {状态}`
- `{人} set priority to {优先级}`
- `{人} assigned {人}` / `unassigned` / `assigned A and unassigned B` / `reordered the assignees`
- `{人} renamed the issue to {标题}`
- `{人} edited the description`
- `{人} set the parent to {任务}` / `removed the parent`
- `{人} added sub-issue {任务}` / `removed sub-issue {任务}`
- `{人} marked {本任务} as blocked by|blocking|related to {任务}`，或 `linked` / `unlinked` 一条 PR 或线程
- `{人} made {编号} private` / `shared {编号} with {项目}`

子任务上的变更带 `issueCode`，所以父任务的时间线也能点名那条子任务。认不出的事件显示 `This update needs a newer version of Capy`。

Agents & bots 只留作者是线程（`jam`）的评论和事件，PR 行不进这一档。

## 我们现在的活动区

工作区标签里的顺序已经和上面的 1→5 同向：标题、编号与相对时间、紧凑属性、描述、子任务、活动。整页任务仍是 affectUI 看板的两栏：左边正文，右边属性卡。这是 R-61 的属性列，不是 Capy 这一列里的属性行。

活动数据已经按时间合成一条（`TaskDetailFrameProps.activity.timeline`）。私有 `Activity` 在有 `timeline` 时用它：字段变更和 Agent 段是安静的一行，讨论是卡片，回复留在卡片里，评论框在列表底部。这和 Capy 的三种行是同一类画面。

投影仍比他们窄，而且读法会把真正的变更挤掉：

- `deriveIssueActivity` 只叙述创建、状态、优先级、标题、负责人、委派、标签、添加子任务。描述正文的差异被跳过。父任务、阻塞、相关、截止日期、估点、项目、PR 的链接和合并都不进活动。
- `taskActivityVersions` 只取最近 50 个修订再并上创建修订，而且活动查询只留 `content.attrs`，正文不在这份投影里。描述自动保存会占满这 50 格，更早的状态变更不再出现。没有「显示更早」。
- 同一人同一分钟的多件事合成一句（R-63）。Capy 是一事一行、各带图标。
- 活动评论框是纯文本。R-64 要求评论里可以 @ 人或 Bot；这个框没有提及。
- 没有按 All / Comments / Agents & bots 筛选，没有未读分隔。我们没有 `unreadSince` 这种读者游标。

评论模型也不同，而且有一部分该留着。我们的讨论可以钉在正文选区上，并可以标成已解决（R-63 的卡片）。Capy 的 issue 评论是 `parentCommentId` 线程，安装包的评论卡片没有「解决」。

## 不要直接搬的部分

这些和现行规则冲突。对齐时间线时保持原样，除非 Alex 另作决定。

- 整页改成单栏、拿掉右侧属性卡。R-61 规定属性列。工作区标签已经按 2026-11-10 的决定把属性放进正文。
- 拆开 R-63 的同一分钟合并，改成 Capy 的一事一行。
- 一个任务挂多条线程，并设「Owner: woken by updates」。R-81 仍是一个任务一段对话；活动里的 Agent 行打开这段对话。
- 自定义状态名（他们的 `state_changed`）。我们的状态集是固定的。
- 把评论的「解决」拿掉，去迁就他们的卡片。

标题保持可编辑。他们这个包的标题是静态 `h1`；我们的可编辑标题来自 2026-11-10 的决定。

## 实现

三步都沿现有修订、讨论和 `timeline` 契约。不新增第二套活动表，不把 Capy 的 timeline 接口搬进来。画面改在私有 `slots/task-detail.tsx`，事件种类和取数改在本仓库。

### 1. 活动区的筛选和窗口

改私有 `Activity`，数据仍用 `activity.timeline(discussions)`。

- 标题行右侧三个筛选：全部、评论、Agent 与 Bot。评论只留 `kind: 'comment'`。Agent 与 Bot 留 `kind: 'agent'`，以及 `actorType` 为 `agent` 的字段变更。PR 行不进后一档，和他们的 `jam` 筛选一致。
- 契约上的事件项加上 `actorType`。`task-detail-frame.tsx` 从已有的 `ActivityActorView.type` 填上。
- 筛完之后默认画最近 50 行。更早的行数大于 0 时，按钮写「显示更早的 {n} 条」，`n` 为剩余条数和 50 的较小值。这是客户端窗口，先不改读接口。

事件行继续遵守 R-63：一行里可以有多句，用现有分隔符接上。图标用这一行第一件事的种类（状态、优先级、链接、人），放在这句话前面。评论卡片、解决、选区摘录、底部评论框保持现在的结构。

### 2. 把已经写进修订的变更说出来

改 `lib/issue-activity.ts` 和 `messages/zh-CN.json`、`messages/en.json` 的 `Workspace.activity`。相邻修订的 attrs 已经在活动投影里，按差集增加这些句子：

- 设置或清除父任务
- 加上或去掉阻塞、相关
- 设置、改期或清除截止日期
- 链接、取消链接 PR；同一条 PR 的状态变成 `merged` 时写「合并了 {仓库}#{号}」
- 项目、估点，用和标签同一类的短句

描述单独处理。活动查询今天不带正文，所以投影看不见「编辑了描述」。在 `taskActivityVersions` 的摘要里加正文哈希（`md5` 一类），不要把正文送进活动响应。同一操作者连续、中间没有其他叙述的描述修订，合成一条「编辑了描述」，时间用最后一条。这样自动保存不会在一分钟里刷出十几句，也符合 R-63 的合并。

活动窗口不要再按「最近 50 个修订」截。`pollIssueVersionSummaries` 增加 `beforeRevision`。服务端从该修订往更旧走，跳过没有任何叙述的修订，凑满一页有句子的修订（描述哈希变化算一条叙述），并带上比较所需的前一条。第一页仍包含创建修订。按钮「显示更早」把当前最旧修订传回去。纯描述自动保存不再把更早的状态变更挤出第一页。

子任务被移除：子任务修订上的 `parentId` 从本任务变成空时，父任务活动写「移除了子任务 {标题}」。这要在读父任务活动时能看到子任务修订的这一差；做不到就先只叙述仍然出现在子任务列表里的「添加了」。不要为了父任务时间线去把子任务后来的每一次状态变更都嵌进来，那是跨任务读，留到这一步做完再看。

### 3. 评论里的 @

活动评论框接上描述编辑器已经在用的提及。候选是当前任务能 @ 的人和 Bot（R-64）。发出去的正文仍走现有 `onComment` / `onReply`。正文里 @ 了一个 Bot 时，走现有的派发入口，不另做一套批准或唤醒。

评论图片、未读分隔、父任务时间线嵌入子任务的后续变更，这一步不做。图片要新的文件存储；未读分隔要每个读者一条已读游标，我们没有 `unreadSince`。

## 怎么验收

- 同一任务上依次改状态、优先级、负责人、标签、父任务、阻塞、截止日期，并保存一次描述。活动按时间只有这些句子；连续的描述自动保存只有一条「编辑了描述」。
- 超过 50 条有叙述的变更时，第一页仍能看见最近的字段变更，而不是被描述保存占满。「显示更早」把更旧的句子接在上面。
- 三个筛选只改变可见行，不改变存储，也不把 PR 行放进 Agent 与 Bot。
- 评论、回复、解决、选区摘录和 Agent 行打开同一段对话，与改之前相同。
- 工作区标签的顺序仍是标题、编号与时间、属性、描述、子任务、活动。整页右侧属性卡仍在。
