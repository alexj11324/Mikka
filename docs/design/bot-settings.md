# Bot settings: personal bots, workspace allowlist

- **Status:** accepted (Alex, 2026-10-30)
- **GitHub:** replaces #442 (workspace 新 Bot 默认值 UI) and #466 (its optimistic lock); builds on #434
- **Figma:** none yet. Layout follows the existing settings rows (`docs/settings.md`) and the right column's 详情 tab.

## What the user does

A member makes a bot and decides what it runs on: its model and its default
repository. An admin decides what members may choose from. This is the
ChatGPT Enterprise / Claude Enterprise pattern: admins govern, owners choose.

## Who controls what

| Setting | Who | Where |
| --- | --- | --- |
| 可用模型: which model families (Mikka 默认 / Codex / Claude) bots may use | Admins | 设置 › 工作区 › Bot 管理 |
| 新 Bot 的初始模型: what a new bot starts with (only an initial value) | Admins | same section |
| Which repositories exist | Whoever installs the GitHub App; the workspace's active members' installations count | GitHub App (unchanged) |
| A bot's 模型, from 可用模型 | The bot's owner only | The bot's 详情 in the right column |
| A bot's 仓库 (default repository), from the installed repositories | The bot's owner only | same |
| 全部 Bot: owner, 空闲 / 运行中 · N 个线程, threads | Everyone reads; nobody edits another person's bot there | 设置 › 工作区 › Bot 管理 |
| Handing bots over when a member leaves | Admins (remove member, unchanged) | 设置 › 成员 |

There is no admin-editable default model or default repository for all bots.
An admin is also an owner of their own bots and changes them like anyone else;
being an admin gives no write access to someone else's bot.

## Settings IA

| Group | Section (id) | Holds |
| --- | --- | --- |
| Personal | 模型订阅 (`models`, formerly 「模型与额度」) | Connecting the person's own ChatGPT/Codex and Claude accounts. Codex and Claude bots run on these. |
| Workspace | Bot 管理 (`bots`) | 可用模型 + 新 Bot 的初始模型 (admins only), then 全部 Bot (everyone) |
| Workspace | 用量 (`usage`) | 额度 and usage limits; unchanged |
| Bot | 详情 › 模型, 仓库 | That bot's own settings, owner only |

The `models` id stays, so old links keep working. Search: 额度 / quota find
用量, 可用模型 finds Bot 管理, ChatGPT / Claude / 订阅 find 模型订阅.

## Behaviour

- A workspace that never saved 可用模型 allows every family. At least one
  family stays allowed; the last switch is disabled.
- A new bot's model is 新 Bot 的初始模型 if set, else the first allowed
  family. Its repository starts empty.
- A bot's model must be in 可用模型 and its repository must be covered by the
  workspace's GitHub App installations; the server refuses anything else
  (`botModelNotAllowed`, `botRepositoryUnavailable`, `botOwnerOnly`).
- Codex and Claude use the owner's own subscription. When the owner picks one
  without a connected account, the row shows 「未连接 Codex 订阅」 linking to
  模型订阅. Nobody sees another person's connected accounts.
- **A model removed from 可用模型** (decided following OpenAI and Anthropic):
  the bot keeps working. Its stored choice is not rewritten; it runs on
  新 Bot 的初始模型, else the first allowed family, and its owner sees
  「Claude 已不在可用模型中」 under 模型 until they pick again. Re-allowing the
  model brings the bot back to it. This follows the references: in ChatGPT
  Enterprise (Workspace settings › Permissions & roles) and Claude Enterprise
  (Organization settings › Models, Claude Code `availableModels`) a model the
  admin turns off is no longer offered and cannot be selected, while the
  product keeps working on an allowed model. The stale model cannot be saved
  again.
- **A repository whose installation is gone** (uninstalled, or its member
  left): the bot has no default repository until its owner picks one; the
  row shows 「acme/app 未安装 GitHub App」.
- Two admins saving 可用模型 at once: the workspace row lock serialises them
  and each save carries the version it read; a stale save writes nothing and
  shows the other admin's settings (`modelPolicyConflict`). A bot save holds
  the settings row `FOR SHARE`, so a model cannot be allowed at check time and
  disallowed before the write.
- A bot's own settings have no version: only the owner writes them. Overlapping
  saves from one page are ordered by `lib/settings/bot-settings-saver.ts`
  (from #442): only the latest request of a field commits or rolls back.

## Data

- `workspace_settings."allowedModels" text[]` (null = all), CHECKed to known
  families with at least one; `"defaultModel"` is the starting model and is
  CHECKed to be in the allowlist; `"modelPolicyVersion"` is the optimistic lock
  (`drizzle/20261030170000_workspace_model_allowlist.sql`).
- `bots.model`, `bots.repository`: the owner's choices (columns already exist).
- `workspace_settings."defaultRepository"` and `"botDefaultsVersion"` (#466)
  are no longer read or written.

## Layout and states

- Bot 管理, admin: 可用模型 section, one row per family with a switch, then
  新 Bot 的初始模型 with a select of the allowed families. Controls are
  disabled while a save is in flight. Then 全部 Bot.
- Bot 管理, member: 全部 Bot only.
- 全部 Bot row: bot avatar, name, 「<owner> · <status>」, status dot. The sheet
  shows 模型 and 仓库 read-only, then the thread list (私有线程 stays redacted).
- Bot 详情: 模型 and 仓库 rows above 例行 and 资料库. Selects for the owner;
  plain text for anyone else.
- Loading: skeleton rows; load error: the settings error alert with 重试;
  save error: toast with the error code's message and the value restored.

## Rules that apply

R-40 (no subtitles; status lines name the state only), R-42 (zh-CN and en),
R-43, `docs/settings.md` rules 1–5. Components are shadcn defaults: `Switch`,
`Select`, `Item`, `Sheet`, `Badge`.

## Copy

可用模型 / Available models · 新 Bot 的初始模型 / Starting model for new bots ·
全部 Bot / All bots · 模型 / Model · 仓库 / Repository · 无 / None ·
{model} 已不在可用模型中 / {model} is no longer allowed ·
{repository} 未安装 GitHub App / {repository} has no GitHub App installation ·
未连接 {model} 订阅 / {model} subscription not connected · 模型订阅 / Model subscriptions.

## Out of scope

- The runtime does not read `bots.model` yet; the model still comes from the
  subscription binding. `resolveBotModel` is what it must call when it does.
- Per-member or per-team allowlists, specific model versions inside a family,
  and audit-log events for 可用模型 changes.
