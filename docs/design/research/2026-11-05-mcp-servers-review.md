# MCP 服务器 (#1397): independent design review

- **Issue:** [#1397](https://github.com/alexj11324/Mikka/issues/1397), "Add MCP servers"
- **Frames:** Figma `zPe5LKycb2XuT1ivCLRw07`, page 「MCP 服务器 2026-11-05」 (`1002:2`)
- **Designer's research:** `docs/design/research/2026-11-05-mcp-servers.md` on branch
  `design/1397-mcp-servers` (revision commit `616916b5`)
- **Reviewer:** an independent Claude Code session that did not draw the frames, run as
  `rules.md` § Design review asks. It used the `ux-heuristics-audit` method (Nielsen's 10
  heuristics, severity 0–4) and a cognitive walkthrough of three tasks.
- **Rounds:** 2. The review stopped when no finding of severity 3 or 4 remained.

## Independent baseline (public docs, 2026-11-05)

These were read before the frames, to judge them without relying on the designer's
research.

| Product | Add flow | Auth | Per-tool control | Errors / recovery |
| --- | --- | --- | --- | --- |
| Claude custom connector | Customize › Connectors › Add custom connector: name, URL, then review the **detected** auth | Sign in now / when needed / none; OAuth client: published, Dynamic Client Registration (DCR) or own ID+secret; request headers | Turn tools off per conversation; allow always / ask | Changing a connector means removing and re-adding it; members re-auth with 连接 |
| Codex app | Settings › MCP servers › Add server: name, Streamable HTTP, URL; then 重启 and 认证 | OAuth (default), bearer token env var, headers | `enabled_tools` / `disabled_tools`; approval `writes` prompts only for tools not marked read-only | The list shows enabled and needs-OAuth states |
| Cursor | `mcp.json` or the marketplace | OAuth PKCE + DCR, fixed client ID/secret, headers | Server switch; approval per call | A failed call shows in chat; MCP Logs panel |
| VS Code | MCP Servers › Add Server: HTTP, URL, ID, scope | Per publisher; trust prompt | Configure Tools per tool; ⋯ Disable / Uninstall | View server output |
| ChatGPT developer mode | Create app: name, description, URL, icon | OAuth or none, "I trust this application" | Tool list on the app | — |

Sources: support.claude.com (custom connectors), learn.chatgpt.com/docs/extend/mcp (Codex),
cursor.com/docs/context/mcp, code.visualstudio.com/docs/copilot/customization/mcp-servers,
developers.openai.com (ChatGPT developer mode; the help-centre page returned 403, so this row is
partly from third-party setup guides by Auth0, Make and MintMCP).

## Heuristic table (final state, after round 2)

| # | Heuristic | Result | Notes |
| --- | --- | --- | --- |
| 1 | Visibility of system status | Pass | Status badge with icon, colour and word (R-87) on the server page, the store row (E1) and iOS (I1). S6/S7 give the cause and time. S1 connecting, S2 waiting for the browser, success toast with the tool count. R2-1 (dimming) is open at 2 |
| 2 | Match with the real world | Pass | 认证 无 / OAuth / API Key and the 请求头 `Authorization` with a `Bearer` prefix match how providers document keys. Tool names are server data, shown as they are |
| 3 | User control and freedom | Pass | 取消 in every dialog state; 编辑 (D3) changes URL, auth and key without losing tool switches or the share; delete is confirmed |
| 4 | Consistency and standards | Pass | Reuses CredentialDialog, AppTile, SettingRow/Switch, ToggleGroup segment, the #1186 share dialog and the existing disconnect wording. 启用 is a switch on web and iOS. F13 (clearing the secret) follows CredentialDialog |
| 5 | Error prevention | Pass | Auth is detected (「已自动识别」); a wrong override gives S5d 「改用 OAuth」; the fixed `Bearer` prefix; delete names workspace members when shared (P3b) |
| 6 | Recognition rather than recall | Pass | Preselected auth; callback URL with a copy button. A server's own icon is open (F16) |
| 7 | Flexibility and efficiency | Pass | A switch per group header; a SearchInput past 20 tools |
| 8 | Aesthetic and minimalist design | Pass | No subtitles; the duplicate tool-count line was removed (R-40) |
| 9 | Recognize, diagnose and recover from errors | Pass | Coded, specific messages: 仅支持公网地址, 找不到 host, 连接超时, 不是 MCP 服务器, 401, 令牌已过期, 无响应 (25 秒超时). Each ends in 重新连接 / 重新检查 / 改用 OAuth / 重试. The chat error links to the server page (C1) |
| 10 | Help and documentation | Pass | 「在 GitHub 创建 OAuth 应用 ↗」 when DCR is missing. No explainer copy |

## Cognitive walkthrough (novice)

| Task | Round 1 | After round 2 |
| --- | --- | --- |
| Add a server with OAuth (Sentry) | Found; the person had to know Sentry uses OAuth (3) | Found: E1 添加 › MCP 服务器 → D1 with OAuth preselected → S2 browser → S4 page with toast |
| Add a server with an API key (Context7) | Present but insufficient: a raw token without `Bearer` gave an unexplained 401 (3) | Found: D2 with API Key detected, `Bearer` fixed, key pasted → S4 |
| Find out why a server stopped working, then reconnect | Missing: the list showed nothing, the page had no cause, a rotated key could not be entered (3) | Found: the chat error (C1) or the store badge (E1) → page with cause and time (S6/S7) → 重新连接, 重新检查, or 编辑 for a new key (D3) |

## What was fixed across the rounds

| Id | Sev | Frame | Finding | Fix (round 2) |
| --- | --- | --- | --- | --- |
| F1 | 3 | D2, S5b | A raw token sent in `Authorization` without `Bearer` gives a 401 | Fixed `Bearer` InputGroupAddon; a pasted prefix is stripped |
| F2 | 3 | D1, D2 | The person must guess the auth method | Detected from protected-resource metadata, 「已自动识别」; new S5d 「此服务器使用 OAuth 登录」 + 改用 OAuth |
| F3 | 3 | P2 | No way to change URL, auth or key; rotating a key meant delete and re-add | ⋯ is 编辑 / 重新连接 / 删除; D3 is the prefilled dialog, key 已保存 until replaced |
| F4 | 3 | S6 | 需要重新连接 with no cause or time; no server-down state | Status line 「令牌已过期 · 时间」; new S7 无响应 with 重新检查 |
| F5 | 3 | E1 | A broken server looked healthy in the web list | Badge on the store row and in 设置 › 连接; new C1 chat error with 打开 Sentry |
| F6 | 2 | P1 | The tool-count line repeated the group headings (R-40) | Removed |
| F7 | 2 | P1 | No bulk tool switches | A switch per group; search past 20 tools |
| F8 | 2 | P2 / I2 | 停用 hidden on web, a switch on iOS; disabled state not drawn | 启用 SettingRow on web; new P5 |
| F9 | 2 | I1 | The iOS switch mixed disabled and broken | Switch means 启用 only; red status line |
| F10 | 2 | S5a | One 无法连接 covered four causes | Separate coded messages |
| F11 | 2 | P3 | Delete-when-shared didn't name members | New P3b |
| F12 | 2 | S3 | No pointer to where to create a client ID | Link to the provider's OAuth app page |
| F17 | 1 | P1 dark | Outline colour | Solid border token |

Declined with reasons the reviewer accepts:
- **F14 (no app shell in the frames):** the frames follow the earlier 插件 draft `773:3`,
  and the column matches `main`.
- **F15 (14 tools, 5 shown):** the group scrolls inside itself (`max-h-96`).

## Remaining severity 1–2 items

| Id | Sev | Frame | Finding | Suggested fix |
| --- | --- | --- | --- | --- |
| R2-1 | 2 | E1 (`1002:3`) | A broken but enabled server's row is dimmed, and dimming means disabled in code (`AppTile dim={!server.enabled}`) | Dim only disabled servers; a broken one keeps full colour plus its badge |
| R2-2 | 1 | P5 (`1014:935`) | When the server is disabled, the tool switches look on but greyed; it's unclear whether they still respond | Render them disabled and keep the stored values |
| R2-3 | 1 | S5b (`1006:1382`) | The 401 sits under an empty field because the secret is cleared on send | Depends on F13 |
| F16 | 1 | All | Every server has the same generic tile | The server's own icon, with the generic tile as fallback (Alex) |

## Open questions for Alex

1. **Detect the auth method, or ask for it?** The frames now detect and allow an override.
   Reviewer: keep detection. It removed the main severity-3 failure in two of the three tasks.
   It needs a backend probe before saving (Pro's API contract).
2. **Rename 自定义 MCP to MCP 服务器?** Reviewer: yes. It matches the 添加 entry and the term the
   other products use (C-06).
3. **Show the server's own icon?** Reviewer: yes, with the generic tile as fallback (F16).
4. **iOS add entry?** Not needed for usability. Optionally a bar button that opens the web
   dialog signed in, as other 插件 rows do (`mobile.md`).
5. **F13: clear the typed secret on send, or keep it until the dialog closes?** The frames
   clear it, as CredentialDialog does. Keeping it makes correcting a typo easier. Either way,
   both key forms should behave the same.

## Notes for the API contract (Pro)

The frames depend on these. They should be agreed in #1397 before either side builds:

- A detection probe that returns the detected auth method for a URL before saving (D1, D2).
- Distinct error codes, each with `RunErrors.*` copy
  ([decision 0330](../decisions/2026-11-05-0330-error-causes.md)):
  - `oauth_required` (S5d)
  - `auth_failed` with the HTTP status (S5b)
  - `token_expired` (S6)
  - `unreachable_timeout` (S7)
  - `private_address` (S5a)
  - `dns_not_found`
  - `not_mcp`
  - `dcr_unsupported` (S3)
  - `oauth_cancelled` (S5c)
- The last-failure cause and its time on the server read model (S6, S7, E1, I1).
- An update path that keeps tool switches and shares when the URL, auth or key changes (D3).
