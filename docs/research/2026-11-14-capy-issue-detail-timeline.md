# Capy 0.8.0 任务时间线：交互和文案

日期：2026-11-14。读者是要改任务详情活动区的人。先改点击和句子，再补事件种类。本文不是决定，不改 `docs/design/decisions/` 或 `docs/design/rules.md`。

上一版把筛选、窗口和缺哪些事件放在前面。那不是差距的主体。Capy 的时间线句子可以点进 thread，我们的句子是纯文本。两边的用词也不是同一类句子。

## 看过什么

- 安装包：`https://capy.ai/download/linux/x64/targz` 跳到 `https://downloads.capy.ai/stable/capy-0.8.0-x64.tar.gz`（161 105 216 字节，S3 `Last-Modified` 2026-11-11 00:09:19 UTC）。渲染进程在 `resources/renderer/`。`bundle-report.md` 写构建 `fe890a8c10f32d877049c0edc1e103925063ad78`，profile `desktop`，channel `stable`。
- 活动句子和点击在 `resources/renderer/assets/index-BNVriEhx.js`：`shared/issues/issue-view.tsx` 的 `IssueActivity`、`CommentAuthor`，以及 `shared/markdown/chips.tsx` 的 `ThreadMentionChip`。句子先拼成字符串，再交给正文用的那套 markdown（`variant: inline`）。扫描器把句子里的编号收成芯片。
- Mikka 的句子在 `lib/task-activity-timeline.ts` 的 `taskHistoryLabel` 和 `messages/zh-CN.json`、`messages/en.json` 的 `Workspace.activity`。装配在 `components/workspace/task-detail-frame.tsx`。官方画面是私有 `mikka-hosted-ui` 的 `slots/task-detail.tsx`（`LogEntry`）。公开 `components/workspace/issue-activity-feed.tsx` 用同一句文案。

## 他们怎么点进 thread

活动行本身不是按钮。能点的是句子里的编号，和评论头上的名字。

句子拼完之后，markdown 用三条正则把词收成芯片：

| 句子里的词 | 正则 | 点开 |
| --- | --- | --- |
| 大写编号，如 `CAP-12`、`CAP-THREAD-4` | `[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[1-9][0-9]*` | 以本项目的 issue 前缀加纯数字结尾的，开那条 issue。其余编号开 `/thread/$threadId` |
| `Task 3`、`Subagent 3` | `(?:Task\|Subagent) [1-9][0-9]*` | 那条任务 |
| `owner/repo#12` | 仓库加 `#` 加数字 | 那条 PR |

写句子时，操作者这样放进句子：没有操作者写 `Capy`；Captain 写显示名；其他 thread 写它的 **code**，没有 code 才写名字。code 正是上面那条编号正则。所以一条 Agent 改状态的句子是 `CAP-4 moved CAP-12 to Done`，`CAP-4` 是 thread 芯片，`CAP-12` 是 issue 芯片。点 `CAP-4` 进入那个 thread。

评论头是第二条路。作者是用户，或被标成隐藏，名字是普通文字。作者是 thread（jam）时，名字是到 `/thread/$threadId` 的链接，悬停有下划线。用户的评论不能这样点。

`linked` / `unlinked` 一句里的 thread、PR、issue 同样来自 `refs`，再被同一套扫描收成芯片。认不出的事件整句是 `This update needs a newer version of Capy`，没有链接。

## 改之前点不进去

官方 `LogEntry` 把字段变更画成一行纯文本：名字用 `<b>`，后面接「状态改为进行中 · 时间」。这一行没有 `onOpen`。名字、任务编号、PR 都不是链接。Agent 改了状态，点那一句没有任何去处。

另有一种 Agent 行，契约是 `kind: 'agent'`。官方把它画成整行按钮，`onOpen` 打开这个任务的同一段对话（R-62）。公开活动列表里，有 thread 详情时也是按钮。这和 Capy 的点法不是一回事：

- 能点的是另一行，可见文字是运行结果（完成、运行中、等你回复），不是刚才那句变更。
- 没有 thread 详情时 `onOpen` 是空的，按钮是禁用的。
- 评论头的名字永远是文字。讨论消息只有 `author` 和可选的 `authorUserId`，没有 thread。

所以时间线上读到的那句变更，点不进对话。Capy 是点句子里的 thread 编号进去。

## 文案

他们一句里有谁、对哪条、做了什么。编号就是链接。我们的名字在句子外面，动词是半句，句子里没有编号。

同一分钟、同一个人的多件事，我们仍合成一行（R-63）。名字只出现一次，后面接分句。分句要能单独读完。下面的中文是要换成的句子，名字由行首承担，不再写进每一分句。

| 事 | Capy，名字在句中 | 我们现在 | 改成 |
| --- | --- | --- | --- |
| 创建 | `{人} created {编号}` | 创建了任务 | 创建了 {编号} |
| 状态 | `{人} moved {编号} to {状态}` | 状态改为{状态} | 把 {编号} 改成了 {状态} |
| 优先级 | `{人} set priority to {优先级}` | 优先级改为{优先级} | 把优先级改成了 {优先级} |
| 标题 | `{人} renamed the issue to {标题}` | 任务重命名为{标题} | 把任务改名为 {标题} |
| 负责人 | `{人} assigned {人}` | 指派给{人} | 指派给了 {人} |
| 取消负责人 | `{人} unassigned {人}` | 取消了负责人 | 取消了 {人} 的负责 |
| 交给 Agent | 他们没有「委派」这句 | 交给{人}执行 | 交给了 {人} |
| 不再交给 | 同上 | 取消了执行委派 | 不再交给 {人} |
| 描述 | `{人} edited the description` | 不写 | 改了描述 |
| 父任务 | `{人} set the parent to {编号}` | 不写 | 把父任务设成了 {编号} |
| 子任务 | `{人} added sub-issue {编号}` | 添加了子任务 {标题} | 加了子任务 {编号} |
| PR | `Opened owner/repo#n 标题` | 不写 | 打开了 {仓库}#{号} {标题} |
| 合并 | `Merged owner/repo#n 标题` | 不写 | 合并了 {仓库}#{号} {标题} |

英文跟 Capy 的动词，主语仍由行首的名字承担：`created {code}`、`moved {code} to {status}`、`set priority to {priority}`、`renamed the task to {title}`、`assigned {name}`、`unassigned {name}`、`handed it to {name}`、`stopped handing it to {name}`、`edited the description`、`set the parent to {code}`、`added sub-issue {code}`、`opened {repo}#{n} {title}`、`merged {repo}#{n} {title}`。

一行读出来是：`Ada 创建了 MIK-12，把优先级改成了高 · 11/14 14:02`。`Ada` 在她是 Agent 时是链接，`MIK-12` 是链接。现在读出来是：`Ada 创建了任务，优先级改为高 · 11/14 14:02`，两处都不能点。

Agent 那一行继续用运行结果词（完成、运行中、等你回复），不改成「换」或「尝试」。它是结果行，不代替上面的变更句。

不要的词：执行委派、任务重命名为、状态改为、优先级改为。这些是字段名加动词，不是一句变更。

## 不要直接搬的部分

- 整页改成单栏、拿掉右侧属性卡。R-61 规定属性列。
- 拆开 R-63，改成一事一行。一行里可以有多句，名字只出现一次。
- 一个任务挂多条 thread，或给每次变更新开一段对话。R-81 仍是一个任务一段对话。点 Agent 的名字，打开的是这段对话里对应的那次运行。
- 评论头上，人的名字变成链接。Capy 只给 thread 作者链接。我们的评论作者是人。
- 拿掉评论的「解决」。

标题保持可编辑。他们这个包的标题是静态 `h1`。

## 实现

第 1 节已经写进公开仓库和 `mikka-hosted-ui` 的 `slots/task-detail.tsx`。第 2 到第 4 节还没做。

点击和文案先做。筛选、窗口、补事件种类留在后面，沿现有修订和 `timeline` 契约，不新开活动表。

### 1. 句子能点，并且读得成一句

改 `taskHistoryLabel` 和 `Workspace.activity` 的中英文字符串，按上一节的表。返回的是分句，不是已经拼好的整行。行首的名字仍由画面加一次。同一分钟的分句继续用现有分隔符接上。

契约上的活动行增加 `parts`，代替把整句当成一个字符串来画：

- `text`：普通词
- `task`：任务编号，带 `taskId`，点开那个任务（现有的打开任务）
- `thread`：Agent 的名字，带 `runId`，点开这个任务的对话并落到这次运行（现有的 `showThread`）
- `pull`：`仓库#号`，带现有 PR 链接

`task-detail-frame.tsx` 填这些 part。字段变更的操作者是 Agent，并且这次变更能对上该任务上的一次运行时，名字是 `thread` part。对不上就仍是文字，不链到空处。本任务、父任务、子任务、被关联的任务写成 `task` part。PR 写成 `pull` part。

官方 `LogEntry` 按 part 画。`thread` 走现在 Agent 行已经用的 `onOpen`。`task` 走任务详情已有的打开任务。公开 `IssueActivityFeed` 用同一套 part，避免开源页仍是死句子。Agent 结果行保持整行可点；没有详情时不要画成一个禁用按钮，这行就保持文字。

评论头不改。讨论消息没有 thread。

### 2. 活动区的筛选和窗口

改私有 `Activity`，数据仍用 `activity.timeline(discussions)`。

- 标题行右侧三个筛选：全部、评论、Agent。评论只留 `kind: 'comment'`。Agent 留 `kind: 'agent'`，以及操作者是 Agent 的字段变更。PR 行不进后一档。
- 筛完之后默认画最近 50 行。更早的行数大于 0 时，按钮写「显示更早的 {n} 条」，`n` 为剩余条数和 50 的较小值。先做客户端窗口。

### 3. 把已经写进修订的变更说出来

改 `lib/issue-activity.ts`。相邻修订的 attrs 已经在活动投影里，按差集增加父任务、阻塞、相关、截止日期、项目、估点，以及 PR 的链接和合并。句子用第 1 节的写法。

描述单独处理。活动查询今天不带正文。在 `taskActivityVersions` 的摘要里加正文哈希，不要把正文送进活动响应。同一操作者连续、中间没有其他叙述的描述修订，合成一条「改了描述」。

活动窗口不要再按「最近 50 个修订」截。`pollIssueVersionSummaries` 增加 `beforeRevision`。服务端从该修订往更旧走，跳过没有任何叙述的修订，凑满一页有句子的修订。纯描述自动保存不再把更早的状态变更挤出第一页。「显示更早」把当前最旧修订传回去。

子任务被移除：做不到就先只写「加了子任务」。不要把子任务后来的每一次状态变更嵌进父任务时间线。

### 4. 评论里的 @

活动评论框接上描述编辑器已经在用的提及。候选是当前任务能 @ 的人和 Bot（R-64）。发出去的正文仍走现有 `onComment` / `onReply`。正文里 @ 了一个 Bot 时，走现有的派发入口。

评论图片和未读分隔不做。

## 怎么验收

- 一条 Agent 改状态的活动，句子是「{名字} 把 {编号} 改成了 {状态}」。点名字打开这个任务的对话，并落到这次运行。点编号打开这个任务。人做的变更，名字是文字。
- 同一分钟里创建、改优先级、指派，读成一句，名字只出现一次。编号仍可点。
- 打开或合并一条 PR 之后，句子里的 `仓库#号` 打开那条 PR。
- 没有 thread 详情的 Agent 结果行不是一个禁用按钮。
- 三个筛选只改变可见行。超过 50 条有叙述的变更时，「显示更早」把更旧的句子接在上面，描述自动保存不占满第一页。
- 评论、回复、解决、选区摘录与改之前相同。整页右侧属性卡仍在。
