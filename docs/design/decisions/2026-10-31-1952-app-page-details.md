# An app's page shows Composio's description, tools and facts, connected or not

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator with screenshots (our 插件 › Supabase page next to Codex's 插件 › Outlook Email): 「你这里不连接，什么东西都不显示啊，这个不对吧？你看人家这个是有命令的，读写都在这上面，还有开发者信息都在这上面。中间那个图你可能很难模仿，但下面的这些介绍之类你得补齐吧」
- Rule: R-40 (data, not filler)
- Replaces: —

A store app's page (rail 插件 › an app, and 设置 › 连接 › an app) shows the same
content whether or not the person has connected it, in Codex's order:

1. Header: icon, name, and 连接 (or the account rows once connected).
2. Composio's toolkit description as a paragraph. Composio has one
   description, so it appears once; there is no separate short line.
3. 工具: Composio's tool list for the toolkit, summarised as
   「包含 N 个工具（W 个写入，R 个读取）」 and grouped 写入 / 读取, each group
   collapsible and scrolling inside. A tool is 读取 when Composio annotates
   it `readOnlyHint`; any other tool, with or without a hint, is 写入, the
   same signal the write judgment (#658) uses. Each row is the tool's name
   and Composio's description.
4. 信息: 类别 (Composio's categories), 开发者 only for the apps where Mikka
   already knew it (Composio does not say), 网站 (Composio's `app_url`) and
   版本 (Composio's toolkit version).

Everything comes from Composio and is read on the server with Mikka's key,
cached for an hour per app; nothing needs a connected account. Mikka writes no
descriptions of its own and leaves out what Composio does not have. Codex's
hero image and example prompts are left out: Composio has neither. GitHub,
Linear and Telegram keep their own pages.
