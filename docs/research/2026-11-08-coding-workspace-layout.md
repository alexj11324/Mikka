# 代码工作区布局调研：Conductor / Claude Code Desktop / Codex（附 Cursor、Linear、GitHub Mobile）

- 日期：2026-11-08
- 范围：调研和结构草图，不改产品代码。Alex 已批准（「可以，先做调研和草图」），由协调会话审阅后再给 Alex。
- 来源：只用厂商官网、官方文档、changelog 和发布文章。每条结论都附 URL；查不到一手来源的标「未确认」。只借鉴模式，不复制代码或素材。
- 草图：Figma `zPe5LKycb2XuT1ivCLRw07`，页面 `1110:2`「代码工作区 草图 2026-11-08」。这是结构草图，不是视觉规范（同决定 2026-11-07-2045 的草图约定）。

## 两个来源变化

- **Codex 桌面版已并入 ChatGPT 桌面 App**（2026-07-09）。文档迁到 `learn.chatgpt.com/docs`，`developers.openai.com/codex` 会重定向过去（https://learn.chatgpt.com/docs/codex-manual.md）。
- **Conductor 宣布加入 Meta**（0.93.0，2026-11-04，https://www.conductor.build/changelog/0.93.0-conductor-is-joining-meta）。文档迁到 `conductor.build/docs`。它以后的走向未知，所以只当参考，不当标准。

## 结论（8 行）

1. 四个产品都以对话为主。改动、文件、终端、浏览器都是对话旁边的标签或面板，放在右侧栏或底部抽屉里。没有哪家为代码另开一个导航入口或页面。协调会话「不加新导航项、不加新页面」的方向是对的。
2. 对话旁总有一个改动摘要（`+42 −18` 或文件列表），点开才是完整 diff。Claude Code 的 Changes 卡片、Conductor 的 Changes 标签都是这样做的。Mikka 可以在任务详情里放「改动」入口（草图 D1）。
3. 都有「铺满」模式：Codex 有 full view / split view / hidden tabs（⌘⇧B 循环切换），Conductor 的 diff 是主区标签，Claude Code 能把面板弹出成独立窗口。审阅模式可以做，但要配快捷键，不能只靠 Esc。
4. 行内评论在每家都是**先攒一批，再一起发**：
   - Conductor 把评论变成输入框里的附件，跟下一条消息一起发。
   - Claude Code Desktop 用 ⌘↩ 一次提交全部；Web 版排队，随下一条消息一起发。
   - Codex 要用户再发一条消息，让它处理这些评论。
   - Linear Diffs 和 GitHub 用单独的提交审阅动作（approve / request changes / comment）结束一轮评论。
   **Alex 已决定（2026-11-08）：** 评论单独做一个「发给 Agent」按钮，和 GitHub、Linear 的提交审阅一样。发送后，这一批评论作为一条消息进入任务的那一个对话（决定 2300），例如「你：2 条评论」，带 `文件:行` 引用。历史看得见，没有隐藏通道。
5. PR 和 CI 状态都放在改动旁边，失败的检查可以交给 Agent：Codex 的 Fix 会把失败检查附进输入框但不发送，Conductor 有 Fix errors，Claude Code 有 Auto-fix。有了 PR 以后，四家都**仍在 App 内**看 diff 和检查，不会只链接出去。
6. 终端统一是底部抽屉或右栏标签，快捷键 ⌘J 或 Ctrl+`。运行、测试、构建来自仓库里配置好的「动作」，按钮在工具栏，输出进终端：Conductor 用 Run 按钮配 `.conductor/settings.toml`，Codex 用 Actions。
7. 手机端各家都是「审阅和指挥」客户端：看 diff、看检查、合并、催 Agent。Cursor 明确说手机上没有编辑器、终端和文件浏览器。所以 iPhone 只放改动、评论和检查是对的。四家 coding agent 的文档都没写手机上能做行内评论，但 **GitHub Mobile 支持在 PR 改动文件的任意行评论**[^gh-mobile]，Linear 手机版能回复评审线程、「send a fix back to an agent」[^lin-mobile]。手机行内评论有先例，留在 P0。
8. 协调会话的提案总体成立。要改的主要有三处：
   - 工作区不是替换任务栏，而是在现有线程面板（已有 对话 / 改动 / 验收）上加标签。
   - 审阅模式左侧窄条要放**任务的对话**，不是 Bot 聊天。
   - 有 PR 之后，改动不能只链接到 GitHub。
   另外还有几处缺口，见下文「提案哪里不对或缺了什么」。

## 对照表（每个产品 × 每块）

格子写「放在哪 · 怎么切换」。

| 块 | Conductor | Claude Code Desktop（Web） | Codex（ChatGPT 桌面） | Cursor Agents Window |
|---|---|---|---|---|
| 对话 | 中栏；每个对话是顶栏标签（⌘T、⌃Tab）[^c-keys] | 可拖拽网格里的主面板；侧问 ⌘; [^cc-desk] | 主栏；标签在旁（split），或隐藏对话（full view），⌘⇧B / ⌘⌥B [^cx-browser] | 中栏；多个对话可并排或网格 [^cu-30] |
| 改动 / diff | 右侧 git 栏的 Changes 标签放文件列表，主区放 diff（⌘⇧D）；分 Uncommitted / Committed [^c-review] | 标题栏的 Changes 按钮，或点侧栏 Changes 卡片上的 `+N −M`；⌘⇧D；可弹出成独立窗口 [^cc-desk] | 侧栏里的 review 标签（⌃⇧G），范围有 Unstaged / Staged / Commit / Branch / Last turn [^cx-review] | 右栏的 Changes 标签，有「上一轮」范围 [^cu-rn] |
| 行内评论 → Agent | 变成输入框附件，随下一条消息发；Agent 也能用工具读 diff 评论 [^c-flow] | Desktop：逐行 + 号添加，⌘↩ 一次提交全部；Web：排队，随下一条消息打包 [^cc-desk][^cc-webqs] | 先写评论，再发一条消息让它处理 [^cx-review] | 本地 diff 评论：未确认；PR 评论有「Fix with Agent」[^cu-rn] |
| 文件树 / 源码 | 右栏 All files；文件在顶栏开标签；⌘P 快速打开 [^c-keys] | 在对话里点路径打开 Files 面板；云端会话只读；文件树：未确认 [^cc-desk] | 文件树 ⌘⇧E；文件标签在侧栏；⌘P [^cx-cmd] | ⌘P、⌘⇧F；文件在右栏开标签 [^cu-aw] |
| 终端 | 右栏底部（Setup / Run / Terminal），⌘J；Big Terminal Mode 占满中栏 [^c-bigterm] | Terminal 面板，Ctrl+`，可最小化、可弹出；只限本地和 SSH [^cc-desk] | 底部抽屉或右栏标签（设置里选），Ctrl+` / ⌘J [^cx-term] | 右栏的终端标签 [^cu-rn] |
| 预览 / 端口 | 内置浏览器标签（⌘⇧B），能在页面上标注；⌘Y 端口转发；云端在工作区详情里设转发 [^c-cloud] | Browser 面板 ⌘⇧B，带 Dev servers 菜单，配置在 `launch.json` [^cc-desk] | 浏览器标签 ⌘T，有 Annotate 标注模式 [^cx-browser] | 浏览器面板或独立窗口；有端口转发菜单 [^cu-browser] |
| PR / 检查 | 右栏 Checks 标签：CI、评审、部署；Fix errors [^c-checks] | PR 和 CI 状态在 Changes 卡片上，⋮ 里有 Auto-fix / Merge when ready [^cc-desk] | 侧栏 Code Review 插件：Summary / Changes / Checks；「Fix」把失败检查附进输入框但不发送 [^cx-review] | PR 标签：Changes / Description / Commits / Checks / Reviews [^cu-rn] |
| 分支 / 提交 | git 栏；⌘⇧Y 提交并推送 [^c-keys] | 输入框下的 Worktree 开关；提交 UI：未确认 [^cc-desk] | review 栏里暂存、提交、推送 [^cx-local] | Changes 标签里暂存、提交 [^cu-rn] |
| 运行 / 测试 / 构建 | 工作区工具栏的 Run 按钮，跑配置好的动作，⌘R [^c-testing] | 没有 Run 按钮；用终端或 Dev servers [^cc-desk] | 顶栏 Actions，在终端里跑 [^cx-local] | 未确认 |
| 撤销文件 / 块 | 按文件撤销（discard）；按块撤销：未确认 [^c-review] | 未确认 | 全部、按文件、按块都能撤销 [^cx-review] | 按文件 discard；按块：未确认 |
| 回到某一轮 | 悬停消息点撤销图标，删掉之后的消息并还原代码 [^c-ckpt] | `/rewind`：还原代码、对话或两者；Web 有「Rewind to here」[^cc-ckpt] | 从早先消息分叉；还原代码：未确认 [^cx-manual] | 时间线上的检查点，只还原文件 [^cu-ov] |
| 窄屏 | 右栏按钮缩成图标；⌘B / ⌘⌥B 开关侧栏 [^c-cl6] | 放不下的按钮进 ⋮；对话太窄时侧栏隐藏 [^cc-desk] | 三档布局 ⌘⇧B；自动折叠：未确认 | Web 版窗口窄于 1024px 时折叠侧栏 [^cu-rn] |
| 手机 | iOS：对话加合并 PR，可远程控制 Mac；看 diff：未确认 [^c-ios] | Claude App 的 Code 标签：指挥云端会话；看 diff：未确认 [^cc-mobile] | 看改动文件、diff、测试结果；iPad 分屏 [^cx-mobile] | 看 diff、检查，合并；**没有终端、编辑器和文件浏览器** [^cu-mobile] |

### 补充：Linear Diffs 和 GitHub Mobile

这两家不是 coding agent，但它们的代码评审是 Alex 决定的先例。

| 块 | Linear Diffs（Reviews） | GitHub Mobile |
|---|---|---|
| diff 在哪 | 侧栏的 Reviews 区，汇集「需要你处理的 PR、你写的 PR、你参与过的评审」；`G` 然后 `R` 打开 Reviews，`O` 然后 `R` 打开某个评审[^lin-diffs] | PR 的 Files Changed 页[^gh-mobile] |
| 单栏 / 并排 | 两种都有，⌘B 切换；小屏可能没有并排[^lin-diffs] | 未确认 |
| 行评论 | 评论贴在代码行旁，可以开线程、回复、表情回应[^lin-diffs] | 改动文件里任意一行都能评论，展开 diff 后连没改的行也可以[^gh-mobile] |
| 怎么提交 | 批准、请求修改、提交评审评论，会更新评审状态并同步到 GitHub；在 GitHub 开的评审草稿不会同步进 Linear[^lin-diffs]。是否先攒成待提交批次：未确认 | 提交评审或批量提交：这篇 changelog 没写，未确认 |
| 合并 | PR 就绪、有权限时可以在 Linear 里合并[^lin-diffs] | — |
| 检查 | 显示整体检查状态和基本信息，不显示行内失败位置[^lin-diffs] | — |
| 手机 | 回复评审线程、留评论、「send a fix back to an agent」；标记已看在设备间同步；大 PR 分段审阅[^lin-mobile] | 就是手机端 |

官方截图（只给链接，未下载）：
- Conductor：首页主图 https://www.conductor.build/conductor-app-hero-light.webp（对话加改动栏）。changelog 里「commenting-on-diff」https://conductor-marketing.t3.tigrisfiles.io/uploads/1767806660570-image.png，「Checks tab」https://conductor-marketing.t3.tigrisfiles.io/uploads/1768607997278-image.png，「Mark files as viewed」https://conductor-marketing.t3.tigrisfiles.io/uploads/1767892873190-CleanShot_2026-01-08_at_09.19.48_2x.png。
- Cursor：https://cursor.com/docs-static/images/agent/file-agents-window-final.png（Agents Window 的文件搜索和查看）。
- Claude Code 文档页没有截图，Codex 文档用渲染组件代替图片，两家都没有可用的官方截图。Codex 的插图说明写着「Integrated terminal drawer open beneath a ChatGPT chat」「Inline code review comments displayed in the review pane」。

## Mikka 该借鉴什么

1. **一个任务一个对话，工作区挂在它旁边。** 现在 `issue-thread-panel.tsx` 已经有 对话 / 改动 / 验收 三个标签，再加上 文件、预览，就是提案里的「工作区」。不新建面板。
2. **改动摘要入口。** 任务详情里放一行「改动 · 3 个文件 +42 −7 · 1 项检查失败」，点开进工作区（D1）。
3. **审阅模式 = Codex 的 full view。** 一个按钮加一个快捷键：铺满 ↔ 侧栏，可以借 ⌘⇧B。Esc 也能退出。按 R-37 瞬间切换，不加动画。
4. **评论批次 + 「发给 Agent」（Alex 决定）。** 评论攒在批次条里，条上写「N 条评论 · 失败检查」，右边是「发给 Agent」按钮（D3 在工作区底部，M1–M3 是悬浮条和 sheet）。任务对话的输入框不放评论附件。发送后，这一批作为一条消息出现在任务对话里（「你：2 条评论」，带 `文件:行` 引用）。改完的结果回到同一个对话，改动标签刷新（同 Claude Code：「appear as a new diff」）。
5. **失败检查附进批次。** 检查行有「附到评论」，学 Codex 的 Fix in Checks：附进批次但不自动发。
6. **范围按尝试切。** 学 Codex 的 Last turn 和 Cursor 的 Last Agent Turn，改动可以按「全部 / 第 N 次尝试 / 某个提交」看。这正好对上决定 2300 里一个对话串起多次尝试。
7. **标记已看。** Conductor 用 ⌃V。审阅时一个文件一个文件地过。
8. **终端是底部抽屉**，⌘J 或 Ctrl+`。「测试 / 构建 / 启动预览」来自仓库里的配置（借 Conductor actions 和 Claude `launch.json` 的做法），输出进终端。

## 提案哪里不对或缺了什么

| # | 提案 | 问题 | 建议 |
|---|---|---|---|
| 1 | 代码任务里，右栏「变成」工作区 | 右栏现在已经是任务和线程：任务详情和线程面板（对话 / 改动 / 验收）。按决定 2300，任务只有一个对话，它也在右栏。整个换掉，对话就没地方放了 | 工作区 = 现有线程面板加上 文件、预览 标签；改动标签始终出现（D2） |
| 2 | 审阅模式里「聊天」缩成左侧窄条 | 有两个对话：中间是 Bot 聊天，右栏是任务对话。评论要发到**任务对话** | 审阅模式隐藏 Bot 列表和 Bot 聊天，左侧窄条放任务对话和它的输入框（D3） |
| 3 | 有 PR 后文件只链接到 GitHub | 四家都在 App 内看 PR 的 diff 和检查 | 有 PR 也照常显示改动，PR 号和检查放在改动上方；「在 GitHub 打开」只是次要链接 |
| 4 | P0「每个代码线程都显示改动，不只在有检查点时」 | 这需要实时数据源：运行时读机器上的 git 状态，Codex 的 review pane 就是这样「reflects the state of your Git repository」。E2B 机器停了以后怎么办没说 | 运行中读机器的工作区 diff；机器回收后退回检查点或 PR 的 diff。超过 8 MiB 时按文件分页加载，不要整块提示「太大」 |
| 5 | 「发给 Agent」按钮 | 如果做成第二条发送通道，对话里就看不到用户说了什么 | Alex 决定保留单独的「发给 Agent」按钮，但发送结果必须作为一条消息进入任务对话，不走隐藏通道（见「借鉴」第 4 条） |
| 6 | Esc 返回 | Esc 在输入框和评论框里还有「取消」的意思，会冲突 | 主入口用 ⤢ 按钮和快捷键，Esc 只在焦点不在输入区时生效 |
| 7 | 规则冲突没提 | R-51 说「右栏只读，不放操作按钮」，可评论、发送、运行测试都是操作 | 需要 Alex 决定：工作区是不是 R-51 的例外 |
| 8 | 终端放第二期 | 按决定 2026-11-01-2300，队友只能看；按决定 0240，任务机器上有凭据。交互式终端会碰到这两条 | 第二期再定：队友的终端只读，只有任务所有者能交互；终端里不显示密钥文件 |
| 9 | 窄屏没说 | 768–1279px 时右栏是浮层，手机网页（< 768px）现在打不开右栏（IA 缺口 G2） | 窄屏时审阅模式直接全屏，对话做成可切换的标签（学 Codex full view） |
| 10 | 手机端行内评论 | 竞品文档没写手机能做行内评论（Cursor 只写了「ask an agent to resolve review comments」） | 可以留在 P0，但要在 TestFlight 上验证长按行出评论框的体验 |

## 草图

Figma 页面 `1110:2`。每张都有浅色和深色版，深色是同一结构切到 Mikka 变量的「深色」模式，颜色全部绑定 `Mikka` 变量集合，没有新调色板。

| 帧 | 浅色 | 深色 | 图 |
|---|---|---|---|
| D1 平常：图标栏、Bot 列表、聊天、右栏任务详情（带「改动」入口） | `1110:4` | `1110:195` | [浅](assets/2026-11-08-ws-d1-normal-light.png) · [深](assets/2026-11-08-ws-d1-normal-dark.png) |
| D2 代码任务：右栏是工作区（对话 · 改动 · 文件 · 预览），检查在改动上方 | `1110:386` | `1110:652` | [浅](assets/2026-11-08-ws-d2-workspace-light.png) · [深](assets/2026-11-08-ws-d2-workspace-dark.png) |
| D3 审阅模式：左窄条是任务对话；改动铺满、范围切换（全部改动）、并排 diff、行内评论、底部批次条「2 条评论 · ios-unit 失败 · 发给 Agent」 | `1111:2` | `1111:336` | [浅](assets/2026-11-08-ws-d3-review-light.png) · [深](assets/2026-11-08-ws-d3-review-dark.png) |
| D4 审阅模式 · 文件与终端：仓库文件树、只读源码、终端抽屉打开 | `1111:670` | `1111:978` | [浅](assets/2026-11-08-ws-d4-files-terminal-light.png) · [深](assets/2026-11-08-ws-d4-files-terminal-dark.png) |
| M1 iPhone 任务的改动：检查、文件、悬浮条「2 条评论 · ios-unit 失败 · 发给 Agent」 | `1112:2` | `1112:109` | [浅](assets/2026-11-08-ws-m1-changes-light.png) · [深](assets/2026-11-08-ws-m1-changes-dark.png) |
| M2 iPhone 文件 diff 和行内评论 | `1112:216` | `1112:301` | [浅](assets/2026-11-08-ws-m2-diff-comment-light.png) · [深](assets/2026-11-08-ws-m2-diff-comment-dark.png) |
| M3 iPhone 评论 sheet，按钮「发给 Agent」 | `1112:386` | `1112:508` | [浅](assets/2026-11-08-ws-m3-comment-sheet-light.png) · [深](assets/2026-11-08-ws-m3-comment-sheet-dark.png) |

草图遵守的规则：
- 没有彩色角点或徽章；状态图标带颜色（2230、0130）。
- 一个任务一个对话（2300）。
- iPhone 标题居中，按钮在右；推入的页面左边只有返回（0120）。
- sheet 没有副标题（R-40）。
- 没有灰色色块：任务属性是面板底色上的「标签 / 值」行，文件头和检查行也不加填充。

草图里的简化，不是决定：
- Bot 头像画成灰色圆，没用 bloub。
- 字体用 Inter 和 Geist Mono；iPhone 应该用系统字体。
- 状态栏和灵动岛是示意。

## 已决定（2026-11-08）

Alex 决定：
- 评论单独做一个「发给 Agent」按钮（「评论单独做一个发给 agent 的按钮」）。批次条写「N 条评论 · 失败检查」，D3 和 M1–M3 都有；任务对话的输入框不放评论附件。
- 发送后，这一批评论作为一条消息进入任务的对话（「你：N 条评论」，带 `文件:行` 引用）。
- iPhone 上的按钮也是「发给 Agent」。

协调会话按参考产品定下：
1. **R-51 例外：** 只有工作区的标签（改动 / 文件 / 预览）可以有操作：评论、发给 Agent、附上失败检查、运行动作。右栏其他部分仍然只读。先例：Conductor、Codex、Linear 的侧栏。
2. **审阅模式：** ⤢ 按钮加 ⌘⇧B（同 Codex）。Esc 只在焦点不在输入框时退出。
3. **改动范围：** 默认看任务的全部改动，可以切换到「第 N 次尝试」或「某个提交」（GitHub PR 页、Codex 的 Last turn、Cursor 的 Last Agent Turn 都是这样）。
4. **终端（第二期）：** 只有任务所有者能交互，队友只读（决定 2026-11-01-2300）。不显示密钥文件（决定 0240）。
5. **手机行内评论留在 P0：** 先例是 GitHub Mobile 在 PR 改动文件上的行评论[^gh-mobile]。

决定草稿：[`docs/design/decisions/2026-11-08-1230-coding-workspace.md`](../design/decisions/2026-11-08-1230-coding-workspace.md)。Epic 草稿：[`2026-11-08-coding-workspace-epic.md`](2026-11-08-coding-workspace-epic.md)。

还没解决的一件事：2026-11-07 的 2045、2230、2300 三个决定文件只在分支 `docs/tasks-only-threads-inside` 上，没进 `main`，但 `components.md` 已经在引用它们。

[^c-keys]: https://www.conductor.build/docs/reference/keyboard-shortcuts
[^c-review]: https://www.conductor.build/docs/guides/review-and-merge ；https://www.conductor.build/docs/reference/diff-viewer ；changelog https://www.conductor.build/changelog/page/9
[^c-flow]: https://www.conductor.build/docs/concepts/workflow （「Inline comments become composer attachments you can send back to the agent」）；https://www.conductor.build/changelog/page/3
[^c-bigterm]: https://www.conductor.build/docs/reference/big-terminal-mode ；https://www.conductor.build/changelog/page/6
[^c-cloud]: https://www.conductor.build/changelog/page/5 ；https://www.conductor.build/docs/cloud/working-with-cloud-workspaces
[^c-checks]: https://www.conductor.build/docs/reference/checks
[^c-testing]: https://www.conductor.build/docs/concepts/testing ；https://www.conductor.build/docs/reference/scripts/run
[^c-ckpt]: https://www.conductor.build/docs/reference/checkpoints
[^c-cl6]: https://www.conductor.build/changelog/page/6
[^c-ios]: https://www.conductor.build/changelog/0.90.0-conductor-for-ios ；https://www.conductor.build/docs/reference/remote-control
[^cc-desk]: https://code.claude.com/docs/en/desktop ；https://claude.com/blog/claude-code-desktop-redesign
[^cc-webqs]: https://code.claude.com/docs/en/web-quickstart ；https://code.claude.com/docs/en/claude-code-on-the-web
[^cc-ckpt]: https://code.claude.com/docs/en/checkpointing ；https://code.claude.com/docs/en/claude-code-on-the-web
[^cc-mobile]: https://code.claude.com/docs/en/mobile
[^cx-browser]: https://learn.chatgpt.com/docs/browser
[^cx-cmd]: https://learn.chatgpt.com/docs/reference/commands
[^cx-review]: https://learn.chatgpt.com/docs/code-review?surface=app
[^cx-term]: https://learn.chatgpt.com/docs/integrated-terminal ；https://developers.openai.com/codex/changelog （26.601 终端位置）
[^cx-local]: https://learn.chatgpt.com/docs/environments/local-environment
[^cx-manual]: https://learn.chatgpt.com/docs/codex-manual.md
[^cx-mobile]: https://learn.chatgpt.com/docs/mobile ；https://developers.openai.com/codex/changelog
[^cu-30]: https://cursor.com/changelog/3-0 ；https://cursor.com/changelog/3-1
[^cu-aw]: https://cursor.com/docs/agent/agents-window ；https://cursor.com/blog/cursor-3
[^cu-rn]: https://cursor.com/docs/release-notes
[^cu-browser]: https://cursor.com/docs/agent/tools/browser
[^cu-ov]: https://cursor.com/docs/agent/overview
[^cu-mobile]: https://cursor.com/docs/cloud-agent/mobile
[^lin-diffs]: https://linear.app/docs/diffs
[^lin-mobile]: https://linear.app/mobile-diffs
[^gh-mobile]: https://github.blog/changelog/2026-02-03-github-mobile-comment-on-unchanged-lines-in-pull-request-files/
