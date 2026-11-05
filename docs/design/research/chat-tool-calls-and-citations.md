# AI 聊天产品中工具调用与引用来源的展示方式对比

调研日期：2026-11-04。只采信官方文档、官方变更日志、开源代码，以及（明确标注的）官方论坛员工回复和 GitHub issue。找不到依据的写"未核实"。

---

## 1. OpenAI Codex

### 1a. Codex CLI（开源 TUI，codex-rs/tui，HEAD `dc1cc0a`，2026-11-04）
- **分组**：只读类命令（Read / ListFiles / Search）连续出现时，合并进一个"exploring"单元；任何其他命令单独成一个单元。判断逻辑见 `ExecCell::is_exploring_call`，源码注释："An `ExecCell` can represent either a single command or an "exploring" group of related read/list/search commands." 组内连续的纯 Read 调用会再合并成一行，文件名去重后用逗号连接。(https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/model.rs , https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/render.rs)
- **标题文案（逐字）**：分组标题运行中是 `Exploring`，完成后是 `Explored`；子行以 `└` 缩进，前缀为 `Read <a, b>`、`List <path>`、`Search <query> in <path>`、`Run <cmd>`。单条命令运行中标题是 `Running <cmd>`，完成后是 `Ran <cmd>`；用户自己执行的命令是 `You ran`。MCP 工具是 `Calling` / `Called`。网页搜索是 `Searching the web` / `Searched the web`、`Searched for '<q>' in <url>`、`Searched page`。(render.rs；https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/mcp.rs ；https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/search.rs)
- **默认折叠**：命令输出最多显示 `TOOL_CALL_MAX_LINES = 5` 行，命令本身的续行最多 2 行，超出部分显示 `… +N lines (ctrl + t to view transcript)`。(render.rs；https://github.com/openai/codex/blob/main/codex-rs/tui/src/ui_consts.rs)
- **错误**：单条命令前的圆点成功为绿色、失败为红色（`"•".green()` / `"•".red()`）。在 Explored 组里，失败的那一行末尾追加 `(exit N)`，复合命令则是 `(command exit N)`，显示为红色。搜索命令 exit 1 可能只是没有匹配，所以用灰色。紧凑模式下失败的标题是 `Exited (status N)`。组标题本身不汇总错误。(render.rs；https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/compact.rs)
- **全局展开**：`Ctrl+T` 打开完整 transcript。(ui_consts.rs)
- **按工具区分的图标**：没有图标，只用 `•` 圆点加颜色，再用动词区分工具。
- **引用**：CLI 的 search 活动"stays visible in the transcript"（https://learn.chatgpt.com/docs/codex/cli）。CLI 有没有引用 pill：未核实。
- **复制/反馈按钮**：未核实（终端界面）。

### 1b. Codex 桌面 App（ChatGPT 桌面 "For coding" 视图）
- **分组 + 默认折叠**：用户 issue 逐字引用了几种折叠行：`Edited 1 file`、`Explored 2 searches`、`Ran 1 command`，并请求加一个"expand activity summaries by default"的设置，可见默认是折叠的（2026-05-21 提出，截至调研时仍为 open，没有维护者回复）。(https://github.com/openai/codex/issues/23868)
- 另一 issue 描述"command activity is collapsed into aggregate rows such as `Ran 2 commands`"，点击后 chevron 从 `>` 变为向下。(https://github.com/openai/codex/issues/20090)
- 标题格式是"过去式动词 + 计数 + 名词"，用户举例的 `Explored 5 files, 6 searches` 符合这一格式。完整的计数拼接规则未核实（App 不开源）。
- 错误样式、全局展开开关、图标、复制按钮：在官方文档中均未找到，未核实。官方 features 页（https://learn.chatgpt.com/docs/features）没有描述线程里的活动渲染。

### 1c. Codex Web（chatgpt.com/codex，Cloud）
- **引用**：官方发布文写道 "Codex provides verifiable evidence of its actions through citations of terminal logs and test outputs"。系统提示规定的引用格式有两种：文件 `【F:<path>†L<start>-L<end>】`，终端输出块 `【<chunk_id>†L..】`。引用要紧跟被支持的分句（行内），文件引用优先。(https://openai.com/index/introducing-codex/)
- 引用在 UI 上的具体样式（pill 还是链接）、去重方式：未核实。工作日志的折叠方式：未核实。

---

## 2. Claude.ai Web 与 Claude Code（CLI + 桌面 App）

### Claude Code CLI
- **分组/折叠**：默认 "the transcript collapses each tool call to a short summary, such as the command Claude ran and a line count of its output"。设置项 `verbose: true` 可以把输入输出全部内联展示。(https://code.claude.com/docs/en/settings-reference#verbose)
- 存在"折叠组"这种渲染单元：官方 mod 文档列出 `ToolUse, ToolResult, ToolGroup` = "A tool call's row, its result, and a collapsed group of calls"。(https://code.claude.com/docs/en/plugins/mods/interface)
- **标题示例（逐字）**：MCP 调用合并为一行，例如 `Called slack 3 times`。(https://code.claude.com/docs/en/interactive-mode)
- **全局展开**：`Ctrl+O` 切换 transcript viewer，"Shows detailed tool usage and execution, with a timestamp and the model used on each assistant message. Also expands lines that collapse by default"。经典渲染器下还可以用 `Ctrl+E` 切换"show all content"。另有 `/focus`："shows only your last prompt, a one-line summary of tool calls with edit diffstats, and the final response"。(interactive-mode；https://code.claude.com/docs/en/fullscreen)
- **错误**：屏幕阅读器模式下每条消息都有标签，类别里包括"errors and warnings"(https://code.claude.com/docs/en/accessibility)。Advisor 失败时显示 `Advisor unavailable (<error_code>)`(https://code.claude.com/docs/en/advisor)。普通工具失败在视觉上的样式（红色等）：未核实。

### Claude Code 桌面 App
- **三档视图**（官方逐字）：Normal = "Tool calls collapsed into summaries, with full text responses"；Thinking = 同样折叠，外加思考内容；Verbose = "Every tool call, file read, and intermediate step Claude takes, plus Claude's thinking"。切换方式是会话菜单 → Transcript view，或用 `Ctrl+O` 循环切换。旧版还有 Summary 模式，已移除。(https://code.claude.com/docs/en/desktop#switch-view-modes)
- 有用户在 Codex issue 中称赞"the verbose transcript view in claude code desktop app"，并以此为由请求 Codex 增加同类功能。(https://github.com/openai/codex/issues/23868)
- 图标、错误样式、复制按钮：未核实。

### Claude.ai Web
- **引用**："Every response includes citations"，包括"Direct citations to sources / Source links for further reading / Relevant quotes when appropriate"。搜索时 "You'll see an indicator that Claude is searching the web." (https://support.claude.com/en/articles/10684626-enable-and-use-web-search)
- API 文档建议的展示方式：在被支持的文本旁放行内引用，并附来源列表；每条引用含 URL、标题和最多约 150 字符的 cited_text。(https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- 反馈按钮：官方帮助中心提到 thumbs up / thumbs down，以及可以"clicking on the 'thumbs down' button on Claude's response"(https://support.claude.com/en/articles/12335811-report-a-concern-australian-dis-standard-compliance)。按钮是始终显示还是悬停显示：未核实。
- 工具步骤：有可展开的"tool step"（2026-10-01 的 changelog 修复了"a crash when opening a tool step"）(https://claude.com/docs/cowork/changelog)。分组规则和标题文案：未核实。

---

## 3. ChatGPT（含 agent 与 deep research）
- **搜索引用**（帮助中心逐字）："Responses that use web search may include citations. Select a citation to open its source. On desktop web, you can also point to a citation to preview it. Select Sources, when available, to view cited sources and other relevant links." (https://help.openai.com/en/articles/9237897-chatgpt-search)。形式是行内引用（桌面端悬停可预览），加上消息末尾的 **Sources** 按钮，后者会列出"cited sources and other relevant links"。2024 年的发布文描述点击 Sources 后打开侧栏 (https://openai.com/introducing-chatgpt-search/)。
- 官方给开发者的引用规范："Place citations at the end of the paragraph, or inline if the paragraph is long"，并且"must not be all grouped together at the end of the response"。(https://developers.openai.com/api/docs/guides/citation-formatting)
- API 层面：`sources` 字段列出所有访问过的 URL，通常多于行内引用。这说明"引用（cited）"和"访问过的来源（consulted）"是分开的两层。(https://platform.openai.com/docs/guides/tools-web-search)
- **Deep research**："You can follow progress as it runs"。完成后打开全屏报告视图，内含"A table of contents / A sources used section for reference checking / An activity history showing how the research progressed"。(https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt)。也就是说，过程活动被收进了报告视图里的一个"activity history"区域，不和正文混排。
- **Agent 模式**："an on-screen narration provides visibility into exactly what ChatGPT is doing"(https://openai.com/index/introducing-chatgpt-agent/)；"outputs include source links or screenshots"；需要登录时用户可以"Take over browser"(https://help.openai.com/en/articles/11752874-chatgpt-agent)。
- 工具分组和折叠规则、错误样式、复制按钮是否只在悬停时出现：未核实。

---

## 4. Cursor（编辑器内 Agent 聊天）
以下依据 Cursor 官方论坛员工回复，非正式文档。
- **分组**：读取、搜索、探索类步骤（file reads、grep、list、glob、web fetch/search、MCP tool-list lookup）"always fold into the 'Explored N tools' summary at every density, including Detailed"（员工 mohitjain，2026-07-10）。MCP 工具调用同样会折叠进 Explored（2026-07-31 的更正）。回合结束后，整段过程收进 `Worked for Ns` 组。(https://forum.cursor.com/t/new-version-hides-agent-tool-call-details-in-defiance-of-setting/165292)
- **不折叠的部分**：在 Detailed 档下，文件编辑和终端命令内联显示。(同上)
- **密度设置**：Settings → General → Layout → "Conversation Density"，说明文字为"Choose how much detail agent tool calls show in the conversation"，可选值包含 Detailed。(同上)
- **标题文案（逐字）**：`Explored 2 searches`、`Thought for 1s`、`Thought briefly`、`Searched files **/lls/**`、`Grepped streamlit`。(https://forum.cursor.com/t/bug-report-cursor-agent-repeatedly-hangs-at-explored-2-searches/161068)
- **错误**：用户报告工具调用失败时显示"Error: Aborted"(https://forum.cursor.com/t/cursor-agent-tool-calls-repeatedly-fail-with-error-aborted-when-reading-or-editing-files/171780)。颜色和图标：未核实。
- 截图：https://us1.discourse-cdn.com/cursor1/optimized/3X/1/a/1a1e53994890aa6009772f2cd7770ffaf02fcbee_2_690x26.png
- 图标、引用、复制按钮：未核实。

---

## 5. Warp（Agent 模式，开源 warpdotdev/warp）
- **结构**：agent 对话块 "render an agent session's reasoning, tool calls, and diffs inline alongside your own work, while the agent's own shell commands still show up as ordinary command/output blocks"。(https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment)
- **标题文案（源码逐字，`app/src/ai/blocklist/block/view_impl/output.rs`）**：用现在进行时加对象，例如 `Reading files...`、`Grepping...`、`Finding files...`、`Searching codebase...`、`Searching the web...`、`Grepping for the following patterns in {path}`、`Finding files that match the following patterns in {path}`、`Searching the web for "…"`、`Reading {count} messages`、`Thought for {}`、`Searching` / `Searched`。取消状态为 `Cancelled grep for …`。(https://github.com/warpdotdev/warp/blob/main/app/src/ai/blocklist/block/view_impl/output.rs)
- **分组**：源码中每个 action 单独渲染，没有发现类似 "Explored N" 的合并汇总。这一点是根据源码浏览得出的推断，未完全核实。
- **错误**：多处使用 `Icon::AlertTriangle` 警告三角图标 (https://github.com/warpdotdev/warp/blob/main/app/src/ai/blocklist/block/view_impl/common.rs)。变更日志提到 agent 命令退出 shell 时"the run now reports as failed with an explanation"。(https://docs.warp.dev/changelog/2026/)
- **引用**：每个回答底部有一个可折叠的 **References** 区，默认收起（`is_references_section_open: false`），内容是 citation chips，包括 agent 记忆引用，后者只在第一轮对话中显示。如果某个动作已经渲染过引用，就不再重复渲染 References 区（源码注释："it will render the citations so don't render them again"）。(output.rs；https://github.com/warpdotdev/warp/blob/main/app/src/ai/blocklist/block.rs)
- **反馈按钮**：回答结束后（"any terminal state (complete, cancelled, or failed)"）才渲染 footer，流式输出时不显示。footer 中有 ThumbsUp / ThumbsDown 按钮，tooltip 文案为"Good response"。在只读 transcript 查看器中隐藏。从源码看 footer 不依赖悬停才出现，但最终视觉效果未截图核实。(output.rs `render_response_footer`)
- 全局展开开关：未发现。

---

## 横向对比表

| 问题 | Codex（CLI / App / Web） | Claude（Code CLI·桌面 / claude.ai） | ChatGPT（搜索/agent/DR） | Cursor | Warp |
|---|---|---|---|---|---|
| 连续工具如何分组 | CLI：只读类合并成 Explored 组，连续 Read 合并成一行；其他命令每条单独。App：按类型汇总行（Edited / Explored / Ran） | 折叠组（ToolGroup）；MCP 合并为 `Called X N times` | DR：活动收进报告的 activity history；其余未核实 | 读/搜/MCP 合并为 `Explored N tools`；结束后整段收进 `Worked for Ns` | 每个 action 单独渲染（推断） |
| 默认折叠？折叠时可见什么 | CLI 显示标题、子行和最多 5 行输出；App 默认折叠，只显示汇总行 | CLI 显示命令和输出行数；桌面 Normal 档只显示摘要 | 未核实 | 读/搜一律折叠；编辑和命令在 Detailed 档展开 | References 默认收起；工具行未核实 |
| 标题文案 | 过去式动词 + 对象：`Explored`、`Read a.ts, b.ts`、`Ran <cmd>`、`Explored 2 searches`、`Ran 1 command`、`Edited 1 file` | `Called slack 3 times`；其余未核实 | 未核实 | `Explored 2 searches`、`Grepped streamlit`、`Searched files …`、`Thought for 1s` | 进行时 + 对象：`Grepping for … in {path}`、`Reading files...` |
| 错误显示 | CLI：圆点变红；组内对应行加红色 `(exit N)`（搜索 exit 1 为灰色）；组标题不汇总 | 有 error/warning 消息类别；视觉样式未核实 | 未核实 | "Error: Aborted"文本 | AlertTriangle 图标 + failed 说明 |
| 全局展开开关 | CLI `Ctrl+T` transcript；App 无（有用户请求） | `Ctrl+O`（CLI transcript；桌面循环三档）、`verbose` 设置、`/focus` | 无（未核实） | Conversation Density 设置 | 未发现 |
| 按工具区分的图标 | 无，用圆点 + 动词区分 | 未核实 | 未核实 | 未核实 | 有图标系统，每个工具的对应关系未核实 |
| 引用位置 | Web：行内 `F:path†L` / 终端块引用，紧跟分句 | 行内引用 + 来源链接（API 建议同时提供来源列表） | 行内引用（悬停预览）+ 末尾 Sources 按钮/侧栏；DR 有 sources used 区 | 未核实 | 回答底部可折叠 References chips；已由 action 渲染过的不重复 |
| 引用是否去重 | 未核实 | 未核实 | Sources 列表合并 cited + 相关链接（去重方式未核实） | 未核实 | 只做"不重复渲染整个区"；记忆引用只在第一轮显示 |
| 复制/反馈按钮 | 未核实 | 存在 thumbs up/down；是否悬停才显示未核实 | 未核实 | 未核实 | 回答完成后出现 thumbs，流式时隐藏 |

---

## 共同模式结论

1. **"探索"类和"副作用"类工具分开处理。** Codex CLI（Read/List/Search 合并成 Explored）和 Cursor（读、搜、MCP 一律折叠进 Explored，编辑和命令内联）的规则几乎一样：只读的探索步骤被压缩，会改变状态的步骤（编辑、执行命令）单独可见。(codex render.rs；Cursor 论坛员工回复)
2. **汇总行用"过去式动词 + 计数 + 名词"。** 例如 `Explored 2 searches`、`Ran 1 command`、`Edited 1 file`、`Called slack 3 times`。运行中用进行时（`Exploring` / `Running` / `Grepping…`），完成后切换为过去式。
3. **默认折叠，详情一键可得。** Claude Code（Normal / Verbose 三档、`Ctrl+O`）、Codex CLI（`Ctrl+T`）、Cursor（Density 设置）都提供全局展开入口。Codex App 缺少这个入口，已成为用户的公开诉求 (issue #23868)，说明用户需要能"记住展开偏好"的全局开关。
4. **错误标在出错的那一行，不靠组标题。** Codex CLI 把红色 `(exit N)` 放在出错的那一行，组标题 `Explored` 不变。它还区分"非失败的非零退出"（grep 没有匹配时 exit 1 用灰色），避免误报。
5. **一次回答结束后，过程被收起，只留结果。** Cursor 的 `Worked for Ns`、Deep research 的 activity history、Claude Code 的 `/focus`，都是在完成后把过程降级为一行摘要。
6. **引用分两层：行内锚点 + 末尾汇总。** ChatGPT（行内引用 + Sources）、Claude（行内 + 来源链接）、Warp（底部 References chips）都把来源汇总放在回答末尾，正文中只保留轻量标记。OpenAI 还规定引用不能全部堆到文末，必须贴近被支持的分句。
7. **"引用过的"与"访问过的"来源要区分。** OpenAI API 的 `sources` 比行内引用多；ChatGPT 的 Sources 面板把两者放在一起，但标注为"cited sources and other relevant links"。
8. **不重复渲染来源。** Warp 在某个 action 已经渲染过引用时，会跳过底部 References；记忆引用只在第一轮显示。这是避免同一来源在每条消息里反复出现的直接做法。
9. **反馈按钮只在回答结束后出现。** Warp 在流式输出中不渲染 footer，结束后（包括失败或取消）才显示 thumbs；各家是否改为悬停才显示，未核实。
10. **图标不是必需的。** Codex CLI 完全不用工具图标，只用状态圆点（绿/红/动画）加动词，信息密度依然很高。

## 可用截图 URL
- Cursor `Explored` 折叠行：https://us1.discourse-cdn.com/cursor1/optimized/3X/1/a/1a1e53994890aa6009772f2cd7770ffaf02fcbee_2_690x26.png
- Codex App `Ran 2 commands` 展开为空的 bug 截图（issue #20090 评论中的图片；链接为带签名的 private-user-images 地址，可能过期）：https://github.com/openai/codex/issues/20090
- Warp agent 文档页的 Loom 缩略图：https://cdn.loom.com/sessions/thumbnails/9cc2451412be43e389a6b1414ea185e4-06833046fab63718.jpg
