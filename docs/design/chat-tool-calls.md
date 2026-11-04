# Chat 工具调用与引用 · 改法规格（Coordinator 2026-11-04 审过）

调研：[`research/chat-tool-calls-and-citations.md`](research/chat-tool-calls-and-citations.md)

范围：只改前端展示（Coordinator chat 及所有用 `ReplyActivity` / `CoordinatorReply` 的一对一 chat）。不改后端协议；需要的后端字段单列在 §6。

## 0. 现状（已核实代码）

| 问题 | 代码位置 | 原因 |
| --- | --- | --- |
| 每个工具一行「使用工具」 | `components/coordinator/reply-activity.tsx` `ToolRow` | 只有 `messages/*.json` 里 `Coordinator.activity.tools.<name>` 列出的 30 个工具有名字，其他（如 Factory、GitHub 动态工具）全落到 `tool: 使用工具`；标题只有动词，没有对象 |
| 失败看不出来 | 同上 | 返回 `{"error":"factoryNotFound"}` 的调用 `state` 仍是 `done`（服务端只在抛异常时标 `error`），所以画成绿勾；原因只在展开后的原始 JSON 里 |
| 没有分组摘要 | 同上 `ReplyActivity` | 连续工具已共用一个 Trace（decision 2105），但每条都平铺，没有一行摘要、没有折叠 |
| 两个 chip | `agent-citations.tsx` `CitationAnchor` / `CitationSources` | 模型正文里同时写了任务引用和线程引用；任务和线程是 `RunSource.issue` 一对一（R-81），却各画一个 chip，「N 个来源」再列一遍 |
| 线程卡片反复出现 | `coordinator-chat.tsx` `item.threads.map(ThreadCard)` + `ChatEventLine` | 每条回复都把它提到的线程画成卡片；R-66 说「一个线程在一段 chat 里只一张卡」，但只在单条回复内去重 |
| 「N 个来源」+ 复制 | `CoordinatorReply` → `CitationSources`；`MessageActions` | 来源行每条回复都常驻；复制在最后一条回复常驻，其余 hover |

## 1. 工具调用分组（R-83）

1. **一组 = 两段文字之间的连续工具调用**（沿用 decision 2105 的切分）。思考行留在组外、组的上方。
2. **组标题是一句摘要**，按「动作类别」计数，用「 · 」连接，失败数放最后、红色：
   - 例：「查看了 1 个任务和 3 个线程 · 1 个失败」「搜索了网页 2 次 · 派发了 1 个线程」「运行了 Factory · 失败」
   - 只有 1 个调用时，组标题就是那一条的标题，不再嵌套一层。
   - 运行中：「正在查看任务…」（取最新一条），带 spinner。
3. **默认折叠**；运行中的组展开显示正在进行的那一条（与 Codex / Claude Code 一致），结束后自动收起；读者自己点过的以读者为准。
   **例外：含失败的组结束后保持折叠，但摘要行本身已带「1 个失败」红字**，不自动展开（避免满屏红）。
4. **展开后逐条显示**，每条一行：类型图标 + 「动词 + 对象」：
   - 「查看任务 ALEX-45」「派发线程 · 在 Mikka-handoff 创建测试文件」「搜索网页“shadcn trace”」「读取邮件 · 周报」「运行 Factory」
   - 对象来自工具 `input` 预览里的已知字段（`identifier`/`title`/`query`/`name`/`repo`…），取不到就只写动词；**绝不写「使用工具」**：未登记的工具显示其可读化的工具名（`github_call` → 「GitHub · repos/get」）。
5. **图标按类型**（lucide，同一套颜色 `text-muted-foreground`）：查看/读取 `Eye`/`FileText`，搜索 `Search`，创建/修改 `Pencil`/`Plus`，派发线程 `Send`，消息/邮件 `Mail`/`MessageSquare`，日历 `Calendar`，网页/浏览器 `Globe`，记忆 `Brain`，GitHub `GitHubIcon`，其他 `Wrench`。失败的那一条图标换成 `CircleAlert` 红色。
6. **失败判定**：`state === 'error'`，**或** 输出预览是带 `error` / `ok:false` 键的 JSON（前端解析，见 §6 的后端建议）。
   - 失败行：红色图标 + 标题后跟原因，「运行 Factory · 没有找到 Factory」。
   - 原因：已知错误码映射成中文（`factoryNotFound` → 没有找到 Factory，`notFound`、`forbidden`、`rateLimited`、`timeout`…，表放 `messages/*.json` `Coordinator.activity.errors`）；未知码显示码本身（等宽字体），不显示整段 JSON。
7. **原始 JSON 只在单条展开后显示**：单条行可再点开，显示输入/输出 `CodeBlock`（现有组件，失败用 destructive 变体）。组展开 ≠ 单条展开。
8. **全部展开 / 全部收起**：
   - 放在每个工具组摘要行的末尾（Coordinator 允许「对话顶部或这组旁边」，选了组旁边，这样不用改 shell 的 header）：图标按钮 `ChevronsUpDown`，tooltip 是「全部展开」/「全部收起」。电脑和触屏上都常驻显示（独立审阅 2026-11-04：Alex 专门要过这个按钮，不能藏起来）。
   - 作用于当前已加载的所有组（展开组，不展开单条 JSON）。读者对单个组的操作之后仍可覆盖。
   - 状态不持久（刷新回到默认折叠）。

### 1.1 调研带来的调整（见调研报告）
- **只读的和有副作用的分开**（Codex CLI 和 Cursor 都这样做）：组摘要先写有副作用的动作，例如「派发了 1 个线程 · 查看了 3 个任务」。派发线程、发邮件、建任务这类动作，组折叠时也必须能从摘要里读出来。
- **措辞**：运行中用进行时（「正在查看任务…」），结束后用过去式（「查看了…」）。
- **摘要只数成功的调用**（独立审阅 2026-11-04）：失败的调用只计入失败数，不写成「派发了」；整组都失败时，摘要写失败的那几个调用名。`dispatch_factory_task`、`wake_bot_computer` 单独分类。
- **失败数写进组摘要**：Codex 不写，失败只标在出错那一行。我们照 Coordinator 的要求把失败数写进摘要，因为 Mikka 的失败少、但每一次都要人处理。出错那一行同时标红并写原因。
- **「查无结果」不算失败**：返回空列表，或像 `rg` 退出码 1 这种没搜到的情况，用灰色，不计入失败数（参照 Codex 的做法）。
- **回答结束后整组收起**，只留下摘要一行（参照 Cursor 的「Worked for Ns」）。

## 2. 引用去重（改 R-15、R-66）

1. **任务和线程是同一件事**：正文里同一句同时引到任务 T 和 T 的线程 R 时，只出线程 chip（点开是线程对话，R-15）；任务 chip 只在任务没有线程时出现。实现：渲染时若某个 `run` 的 `issue.id` 也在本条回复的引用里，那个任务引用不画（句子里已有线程 chip）。
2. **一段对话里一个线程只有一张卡片**：卡片只出现在**第一次**派发/提到它的那条回复下（以已加载的列表计）；后面再提到时，正文里是行内链接样式的 chip，不再在回复底下挂卡片。卡片原地更新状态（R-66 已有）。
3. **事件行**（「ALEX-45 在等你回答」）：同一线程连续多条同类事件只保留最新一条。
4. ~~同一条回复内第二次起写纯文字~~ —— 已被 2.5 第 4 条取代。

### 2.5 chip 画法（按 Nielsen 10 条定，Claude App 只作参照）

1. **一眼分清任务和线程（Alex 2026-11-04：「issue 和 chat 的状态要有区分度，一看就知道哪个是 issue，哪个是 chat」）**。任务一律用**圆圈**：沿用看板上那套任务状态图标（○ ◌ ◉ ✓ ✕ ⊘）。线程一律用**对话气泡**，状态用气泡右上角的色点表示：琥珀是等你，红是受阻，绿是已解决，灰点闪烁是运行中，空心灰是空闲。线程的任何地方都不再用圆圈：现在 `ThreadStatusIcon` 的 `CircleCheck`、`CircleSlash2`、`CircleAlert`、`LoaderCircle` 都要换掉，其中 `CircleCheck`、`CircleSlash2` 和任务用的完全是同一个图标，这是分不清的根源。影响范围：chat chip、线程卡片、线程列表、任务的「线程」标签页、手机端（R-15、R-52、R-66）。色点不能只靠颜色表达状态：在列表和卡片里，色点旁边都要写状态文字；放在 chip 里时，状态写进 aria-label。Artifact 用叠层图标。
2. chip 的文字统一用 accent 色。图标颜色：任务按看板颜色；线程气泡本身用 accent，只有色点带状态色。
3. **字号跟正文一样**，不写死 20px 高度；可以换行（`box-decoration-break: clone`），名字最多显示两行，超出的部分用省略号（H8、H6：名字本身就是信息，不能截成几个字）。
4. **同一个对象在正文里每次出现都画成 chip**（H4：同一个东西长得一样、点了效果一样）。重复的根源不在正文里的 chip，而在回复底下的卡片和「N 个来源」，这两处按 2.1–2.3 和 §3 去重。**这一条取代 2.4「第二次提到写成纯文字」。**
5. **任务和线程合并成一个 chip**：任务有线程时只显示线程 chip，点开是线程对话；任务编号放在 hover 卡片里（H2：用户脑子里这是同一件事）。
6. 网页链接继续用不带底色的来源 chip，和内部对象一眼区分开（H4）。
7. 对象已删除或没有权限时，chip 变灰并写「已删除」，点了没有反应（H9）。现有的查找中骨架屏保留（H1）。
8. 焦点环保留；正文里的行内链接按 WCAG 2.5.8 属于 inline 豁免，不强制 44px 点击区。

## 3. 「N 个来源」和复制

- 「N 个来源」只统计**网页**来源（任务/线程已经在正文里，不再重复列）。没有网页来源就不显示。
- 来源行和复制按钮合成一行操作条，放在回复最后一个气泡下面：`[复制] [N 个来源 ▾]`，**只在 hover/聚焦时出现**；触屏常驻但缩成图标（来源显示为叠放 favicon + 数字）。最后一条回复也只在 hover 出现（与 Claude.ai 一致；ChatGPT 最后一条常驻——见调研，可选）。
- 间距：气泡与操作条 `gap-1`，操作条左缘与气泡左缘对齐（去掉 `-ml-1` / `-mt-1.5` 的补偿）。

## 4. 排版

- 回复内纵向节奏：思考/工具组 → 气泡 `gap-2`；气泡 → 线程卡片 `gap-2`；卡片 → 操作条 `gap-1`。
- 工具组在手机 390 宽下单行截断，摘要不换行；展开后每条单行截断，长对象 `truncate`。
- 线程卡片宽度与气泡最大宽度一致（`max-w-md` 保持）。

## 5. 文案（R-40 检查过）

| key | zh-CN | en |
| --- | --- | --- |
| activity.group.read | 查看了 {items} | Viewed {items} |
| activity.group.failed | {count} 个失败 | {count} failed |
| activity.expandAll / collapseAll | 全部展开 / 全部收起 | Expand all / Collapse all |
| activity.errors.factoryNotFound | 没有找到 Factory | Factory not found |

无副标题、无解释句。

## 6. 需要后端的（转 Pro，不阻塞本 PR）

1. **工具结果的失败标记**：工具返回 `{error}` 时把 `ChatTool.state` 记为 `error`，并给 `errorCode`。前端先靠解析预览兜底。
2. **工具调用的对象标签**：`ChatTool.target`（如 `ALEX-45`、搜索词、仓库名），由服务端从完整 input 取，避免前端从 200 字截断的预览里猜。
3. 未知工具的展示名：服务端在工具注册处给 `displayName`（含 MCP / GitHub 动态工具）。
4. **不要在回复末尾单独列一行引用**。前端渲染时 chip 留在模型写的位置，`CitationAnchor` 不会把它挪到气泡底部。所以截图里挂在气泡底部、单独成行的两个 chip，是模型在正文末尾专门写了一行引用。要改的是 Coordinator 的 prompt（`lib/coordinator/instructions.ts`，第 37 行附近）：引用写在提到对象的那句话里，不在末尾汇总；任务已经有线程时，只引线程。前端这边，任务和线程同时出现时只画线程 chip，作为兜底。

## 7. 验收

- `ux-heuristics` 每屏 ≥ 8；`cognitive-walkthrough`：「看懂 bot 刚才做了什么」「找到失败的那一步」，记录点击/滚动次数（目标：前者 0 次点击读摘要，后者 ≤ 1 次点击）。
- 390 / 1440 截图（本地 `next build` + `next start`，leased 测试账号），附到 PR。
- 单测：分组摘要计数、失败判定（state 与 JSON error 两种）、任务/线程去重、卡片只出一次。
- 同步：`docs/design/rules.md` 改 R-15、R-66，新增工具组条目；`lint:ui` / `check-copy` 增加「禁止 `使用工具`」「`ReplyActivity` 不得渲染原始 JSON 于组层」的检查；`docs/design/decisions/` 记一条。
