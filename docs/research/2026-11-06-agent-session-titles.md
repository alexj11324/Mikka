# Claude Code / Codex 会话标题：第三方客户端怎么拿、Mikka 能否直接用

> 后续决定见 [任务短标题](../design/decisions/2026-11-06-1400-task-short-titles.md)。
> Alex 采用 Mikka 自己的小模型在任务创建后生成短标题，原生 Claude Code / Codex
> 标题不读取。下面保留当日调研与被后续决定取代的建议。

日期：2026-11-06。只用一手资料：官方文档、CHANGELOG、源码。所有 GitHub 仓库都是当天 `--depth 1` 克隆，下面给出读到的 commit。凡写「未查到」的，就是没有找到一手依据。

## 1. Claude Code（CLI 2.1.318，Agent SDK 0.3.318）

**标题来源与时机**
- 用户没有命名会话时，Claude Code 会在后台请求一次 small/fast 模型（「normally a Haiku-class model」），用第一条 prompt 生成一个短标题。官方文档写明：「A `claude -p` run you start directly from a shell or script doesn't get one.」接受计划后，标题会被换成按计划生成的标题。来源：[Manage sessions › Name your sessions](https://code.claude.com/docs/en/sessions#name-your-sessions)。
- CHANGELOG（[CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)）：
  - 2.1.234：标题改为简短名词短语，例如「Login button bug」。
  - 2.1.277：「Removed the background Haiku auto-title request from `claude -p` runs launched outside an SDK or IDE」。也就是说，经 SDK 或 IDE 启动的运行仍会生成标题。
  - 2.1.314：以 skill 或命令开头的会话也会得到标题；第一条 prompt 失败的会话后续也能补上标题。
  - 2.1.317：修复 cloud/SDK 会话在生成标题期间来新消息或 Stop 时标题丢失的问题。
- 本机 CLI 2.1.318 的二进制（只读 `strings`）印证了以上几点：
  - 系统提示词的开头是「You are naming a coding session so the user can pick it out of a long list of sessions…」。
  - 要求是 2–5 个词的名词短语、句首大写，语言跟随用户。返回值是 JSON schema `{title}`，`querySource: "generate_session_title"`。
  - 输入取会话里 user/assistant 文本的最后 1000 字符。少于 10 字符时不调用模型。
  - 结果用 `{"type":"ai-title","aiTitle":…,"sessionId":…}` 追加到 transcript，规则是 last-wins。
  - headless 路径里有一个开关，在以下情况被预置为「已尝试」：会话已有消息（即 resume）、设置了 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`、或入口是 `sdk-cli` 且没有 `CLAUDE_AGENT_SDK_VERSION`。Agent SDK 会设置这个环境变量，所以按代码读，SDK 新会话会生成标题，resume 时不再重新生成。

**模型、费用、额度**
- 模型选择在代码里读到的是 small-fast 模型：`ANTHROPIC_SMALL_FAST_MODEL`，否则用 `haiku` 别名或 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。Bedrock/Vertex 另有回退。来源：[env-vars](https://code.claude.com/docs/en/env-vars)、2.1.285 CHANGELOG。
- 请求带的是会话本身的 `credentials`，所以按代码读，它和主会话共用账号，订阅用户算在订阅额度里。官方文档没有给出单独的价格或额度说明（未查到）。[costs › Background token usage](https://code.claude.com/docs/en/costs#background-token-usage) 没有列出标题请求。
- 开关：`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`，文档原话是「also skips the background small/fast-model request that generates a session title」。另外，SDK 的 `Options.title` 或 `-n` 提供自定义标题时会跳过自动生成。来源：[env-vars](https://code.claude.com/docs/en/env-vars)、sdk.d.ts 中 `Options.title`。

**外部程序能否拿到**
- stream-json / SDK 消息流：没有 AI 标题。`system/session_title_changed` 被标为 `@internal`，而且明确写着只发用户或 host 设置的名字（「not an AI-generated title」）。来源：CLI 2.1.318 内的 schema 描述。
- 读 JSONL：`~/.claude/projects/<project>/<session>.jsonl`（受 `CLAUDE_CONFIG_DIR` 影响）里最后一条 `ai-title`。官方说这个文件格式是内部格式，「changes between versions」。来源：[sessions › Where transcripts are stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)。
- SDK 公开函数 `listSessions()` / `getSessionInfo()` 返回 `SDKSessionInfo`：
  - `summary` 按 customTitle → aiTitle → 首条 prompt 的顺序取值（sdk.mjs 实现）。
  - `customTitle` 字段在 store 路径下等于 customTitle 或 aiTitle。
  - 它们按调用进程的 `CLAUDE_CONFIG_DIR` 找文件，没有参数可以指定 config 目录。
  - 来源：`@anthropic-ai/claude-agent-sdk@0.3.318` 中 `sdk.d.ts` 的 `SDKSessionInfo`，以及 `sdk.mjs`。
- 按需生成：运行时的 `Query` 对象有 `generateSessionTitle(description, {persist})`，对应 control request `generate_session_title`，但 `sdk.d.ts` 里没有声明，属于非公开 API。另有公开的 `renameSession()`，hook 输出里也有 `sessionTitle` 可以写标题。
- 矛盾点：Lody 的 Claude 适配器注释（基于 SDK 0.3.220）称「Claude Code's own auto-title generation never runs under the Agent SDK」，所以它改为主动调 `generate_session_title`。这和 2.1.277/2.1.317 的 CHANGELOG 以及 2.1.318 的代码不一致。Mikka 接入前需要在一次真实 run 的 JSONL 里确认是否有 `ai-title`。

## 2. Codex（openai/codex @ ddd1812）

- **谁生成**：只有 Codex TUI 这个客户端会生成，app-server 本身不生成。
  - 位置：`codex-rs/tui/src/app/thread_title.rs`，触发点在 `thread_routing.rs:2149-2181`。
  - 时机：线程还没有名字时，第一条用户消息完成后。
  - 做法：开一个隐藏的临时线程（`ThreadSource::Feature("thread_title")`），用结构化输出 `{title}`，最长 36 字符。提示词要求以祈使动词开头、使用用户的语言。
  - 结果用 `thread/name/set` 写回。
- **模型**：常量 `THREAD_TITLE_MODEL = "gpt-5.6-luna"`，reasoning 为 low。只在 provider 是 `openai`、登录的是 ChatGPT 账号、且模型目录里有这个模型时才用它，否则用当前会话模型（`thread_title.rs:31-97`）。请求走 app-server 的普通 turn，用的是用户自己的认证，因此计入用户的 Codex 额度。这是按代码推断，官方文档里未查到相关说明。
- **外部能拿到什么**：
  - app-server v2 的 `Thread.name`：「Optional user-facing thread title」（`v2/thread_data.rs:286`）。
  - `Thread.preview`：「Usually the first user message」（`thread_data.rs:224`）。
  - `thread/name/set`（`common.rs:640`）和通知 `thread/name/updated`（`common.rs:2050`、`v2/thread.rs:2259`）。
  - 但是第三方客户端直接驱动 app-server 时，没有人会写 `name`，除非客户端自己像 TUI 那样生成。
  - `codex exec --json` 的 `thread.started` 只有 `thread_id`（`exec/src/exec_events.rs:40`）。
  - Python SDK 只有 `set_name()`（`sdk/python/src/openai_codex/api.py:672`）。
  - Codex 桌面 App 是否另有生成逻辑：未查到（未开源）。

## 3. LobeHub（lobehub/lobehub @ 80c811e）

- **运行中的 Claude Code / Codex 话题（heterogeneous agent）**：标题不读 CC 的 ai-title，而是 LobeHub 自己的系统助手生成。
  - `src/store/chat/slices/agentRun/actions/lifecycle/buildRunLifecycle.ts` 的 `afterUserMessagePersisted` 注释写明「Single home for all three runtimes」，即 client、gateway、hetero 共用这一处。
  - 新话题在用户消息持久化后调用 `summaryTopicTitle`（`src/store/chat/slices/topic/action.ts:474`）。它用 `systemAgentSelectors.topic` 选出的模型做 `generateJSON`，schema 是 `TOPIC_TITLE_JSON_SCHEMA`。
- **默认模型**：`topic` 用的是 `DEFAULT_MINI_SYSTEM_AGENT_ITEM`（`packages/const/src/settings/systemAgent.ts`），开源默认值为 `openai` / `gpt-5.6-luna`（`packages/business/const/src/llm.ts:9-10`）。用户可以在系统助手设置里改。
- **只有导入本地历史会话时才读 CC 标题**：
  - 桌面端 `apps/desktop/src/main/controllers/HeteroSessionCtr.ts:109` 调用 `parseClaudeCodeSessionDigest`。
  - 标题取 `ai-title ?? 截断的首条 prompt`（`packages/heterogeneous-agents/src/transcript/claudeCode.ts:337-366`）。
  - 导入 Codex 会话时取首条用户文本（`transcript/codex.ts:341-347`）。

## 4. Lody（lody.ai；LodyAI/Lody @ 29040a6，LodyAI/acp-extension-claude @ 5b07ae5）

- **是什么**：第三方的 coding-agent 工作台。本机或服务器上跑 daemon（`npx lody daemon start`），有桌面端和 iOS/Android，经 ACP 适配器驱动 Claude Code、Codex、Grok 等，每个会话一个 worktree。来源：[lody.ai](https://lody.ai/)、[docs](https://lody.ai/docs/)、[GitHub](https://github.com/LodyAI/Lody)。
- **标题策略**：provider 自己能出标题，就用 provider 的；否则由 Lody 单独起一个会话生成。
  - 依据：`specs/acp-session-titles.zh.md`、`apps/cli/src/agent/README.md#session-titles`、`.agents/notes/implemented/architecture/2026-09-08-acp-owned-session-titles.md`。
  - **Claude**：适配器在每个 turn 结束（`session_state_changed: idle`）时，调用 SDK 的非公开 `generateSessionTitle`，即 `generate_session_title` control request，输入是最近 1000 字符的会话文本，再经 ACP `session_info_update` 推送标题（`acp-extension-claude/src/session-titles.ts`）。所以 Claude 的标题实际由 CC 内部的 small-fast 模型生成。
  - **内置 Codex**：由 Lody 自己的 `apps/cli/src/agent/title-generator.ts` 起一个独立会话生成，默认 `gpt-5.6-luna`、reasoning low、用 provider 原有认证。所需选项不可用时，回落到从 prompt 截取的标题，不会换模型。
  - 用户手动起的名字始终保留。

## 5. Happy（slopus/happy @ 534bf42）

- 不读 CC 的 ai-title，也不另调小模型，而是让主 agent 自己起标题。
  - Claude 路径：向 system prompt 注入「ALWAYS when you start a new chat - you must call a tool "mcp__happy__change_title"…」（`packages/happy-cli/src/claude/utils/systemPrompt.ts:8`）。
  - 本地 MCP 工具 `change_title` 把标题作为 `summary` 消息上报（`claude/utils/startHappyServer.ts:60-70`）。
  - Codex 和 Gemini 用同样的指令（`gemini/constants.ts:26`、`codex/happyMcpStdioBridge.ts`）。
  - 本地模式会过滤掉 CC 自己的 `summary` 消息，注释原话是「we generate our own」（`claude/claudeLocalLauncher.ts:19`）。
- 代价是标题占用主模型的一次工具调用和上下文，质量和时机都取决于 agent 是否听话。

## 6. 2026-11-06 调研时的 Mikka 状态

- **线程名今天怎么来**：
  - 有任务的线程用任务标题。
  - 聊天线程用 prompt 的第一条非空行，去掉 Markdown，限 60 字符；为空时用 bot 名。实现：`lib/issue-threads.ts` 的 `threadName`，SQL 版在 `lib/issue-thread-list-projection.ts`。
  - bot 侧列表用 `lib/workspace-admin/bot-threads.ts` 的 `botThreadTitle`：任务标题只对能看到该任务的人显示；prompt 只对发起人显示，限 80 字符。
- **Claude**：daemon 用 Agent SDK 的 `query()` 启动 CLI（`packages/daemon/src/adapters/claude.ts`），每个 run 有独立的 `HOME` 和 `CLAUDE_CONFIG_DIR`。`CLAUDE_RUN_ENV` 没有关闭标题，因此按 2.1.318 的代码读，CC 会把 `ai-title` 写进 `<run 的 CLAUDE_CONFIG_DIR>/projects/<cwd 编码>/<sessionId>.jsonl`，而 Mikka 目前不读它。
- **Codex**：daemon 直接驱动 `codex app-server`（`adapters/codex.ts`，`thread/start` / `turn/start`），不会有自动 `name`。
- **可借用的挂点**：adapter 已有 `onRuntimeModel(sessionId, model)` 回调（`adapters/types.ts:116`），同类的 `onSessionTitle` 可以照它的方式往上报。

上面的独立 HOME / `CLAUDE_CONFIG_DIR` 描述属于调研时源码。后续执行环境按
[机器执行边界](../design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)
保留原生 CLI 的普通 HOME。下面的原生标题接线方案已由上方任务短标题决定取代；实际实现见
[`lib/short-title.ts`](../../lib/short-title.ts)。

## 给 Mikka 的建议

**结论：两边都用 harness 原生能力，现有首行规则保留作兜底；不新增服务端标题模型。**

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| A. 直接用 CC 的 ai-title / Codex 的同类做法 | Mikka 不付费，走用户自己的订阅；CC 的提示词专为「会话列表里认出来」调过，语言跟随用户；与用户在 CC 里看到的名字一致 | CC 标题只在 JSONL 里，格式是内部格式，会随版本变；Codex 的 app-server 不自动起名，得 Mikka 自己按 TUI 的做法起临时线程；会占用用户少量额度 |
| B. Mikka 服务端小模型统一生成 | 两种 harness 风格一致；可控、可测；不依赖内部格式 | Mikka 付费（按 AGENTS.md 属于真实成本）；prompt 要发到服务端模型，增加隐私面；和 CC 里的名字不一致 |
| C. 主 agent 自己调工具起名（Happy 做法） | 不额外调用模型 | 污染主上下文；依赖 agent 是否遵守；违背 Mikka 的 system prompt 精简原则 |

**接线位置（daemon 侧，事件驱动，不轮询）**
1. **Claude**：
   - 在 turn 结束（`result` 消息）时，读一次该 run `CLAUDE_CONFIG_DIR` 下 `<sessionId>.jsonl` 的尾部，取最后一条 `"type":"ai-title"`。CC 自己读标题也是这样，在尾部 64 KB 内找。
   - 也可以在设好 `CLAUDE_CONFIG_DIR` 后调用 `getSessionInfo`，但这个函数按进程环境变量定位目录，需要注意隔离。
   - 用一个 fixture 测试锁住解析逻辑；格式变化时回落到首行规则。
   - 第一步先用一次真实 run 确认 SDK 路径下确实生成了 `ai-title`，因为 Lody 的结论与官方 CHANGELOG 相反。如果没有生成，再评估非公开的 `generateSessionTitle`（有 API 风险）。
2. **Codex**：
   - 第一次 turn 完成后，在同一个 app-server 上起一个临时线程，用用户的 Codex 订阅生成标题，做法同 TUI 的 `thread_title.rs`：结构化输出、reasoning low、≤36 字符。
   - 模型按订阅用的 small 模型选；不可用时直接放弃，不换模型。
   - 成功后再 `thread/name/set`，让用户在 Codex 里看到同一个名字。
   - 是否接受每个线程多一次付费调用，由 Alex 决定（AGENTS.md「Keep a flag only for real cost」）。
3. **上报与展示**：
   - adapter 新增 `onSessionTitle(sessionId, title)`，经现有 run 事件通道写入 `agent_runs` 的新标题列，并通过 live channel 推送。
   - `threadName` / SQL 投影改为 `coalesce(生成标题, 首行, bot 名)`；有任务的线程仍用任务标题。
   - 生成标题来自 prompt，可见性必须与 prompt 相同：只对发起人显示（沿用 `botThreadTitle` 的规则）。
   - 用户手动改名的优先级高于生成标题。
