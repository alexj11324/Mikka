# Research: adding a remote MCP server (issue #1397)

- **Date:** 2026-11-05
- **Issue:** [#1397](https://github.com/alexj11324/Mikka/issues/1397) — connect any remote MCP server from 插件
- **Figma:** file `zPe5LKycb2XuT1ivCLRw07`, page 「MCP 服务器 2026-11-05」 (drafts, not accepted)
- **Status:** research for a design draft. Nothing here is a decision until Alex accepts the frames and a file lands in `decisions/`.

Sources are the vendors' own help pages and release notes, read on 2026-11-05.
No account was created on any product; where a page does not say something, the
table says 「not documented」 instead of guessing.

## Products compared

| | Claude (claude.ai) | ChatGPT | Cursor | Codex (app, IDE, CLI) | VS Code | Windsurf / Devin Local | LobeHub |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Entry point** | Customize › Connectors › 「+ Add」 › 「Add custom connector」. Team/Enterprise: owner adds it in Organization settings › Connectors › Add › Custom › Web; members then 「Connect」 themselves [1] | Plugins › + › 「Add custom MCP server」 (legacy: Settings › Apps › Create) [2] | Customize (sidebar) or `mcp.json`; Marketplace 「Add to Cursor」 [3] | App: Settings › MCP servers › 「Add server」; IDE: gear › MCP servers › Add server; CLI `codex mcp add` [4] | 「MCP: Add Server」 command, or Chat: Open Customizations › MCP Servers › Add Server (+) per User / Workspace group; @mcp gallery [5] | Settings › Tools › 「Add Server」, MCP plugin store; Devin Local: Customize › MCPs [6][7] | Plugin icon › Plugin Store › 「Add MCP Plugin」 (store has LobeHub / Skills / MCP tabs, 「Add」 top right) [8][9] |
| **Form fields** | Name → Remote MCP server URL → Continue → auth review (pre-detected) → Authentication (Sign in now / Sign in when needed / No sign in) → OAuth client (Claude's published identity / Register automatically / Use your own OAuth client) → Request headers [1] | Name, Description (optional), Icon, MCP server URL (or Tunnel), authentication [2] | JSON: `url`, `headers`, `auth { CLIENT_ID, CLIENT_SECRET, scopes }` [3] | Name, transport (STDIO / Streamable HTTP), URL; config: `bearer_token_env_var`, `http_headers`, `env_http_headers`, `scopes` [4] | 「HTTP (HTTP or Server-Sent Events)」 or 「Command (stdio)」, then the URL [5] | `serverUrl` (or `url`) and `headers` in `mcp_config.json` [6] | Connection method (Streamable HTTP / STDIO), Name, Connection URL, auth [9] |
| **Transport** | Not asked | Not asked | Not asked for URL servers | Asked (STDIO vs Streamable HTTP) | One 「HTTP」 choice covers HTTP and SSE | Streamable HTTP and SSE, not asked separately | Asked |
| **Auth choice** | Detected first, then editable: OAuth or no sign-in; fixed headers for API keys [1] | OAuth or none; refresh tokens need `offline_access` [2] | OAuth when the server asks; static `CLIENT_ID`/`CLIENT_SECRET` when the provider has no DCR [3] | OAuth by default (`codex mcp login`), or a bearer token / header [4] | OAuth per MCP spec: DCR first, then falls back to asking for a client ID and secret [10] | OAuth for HTTP and SSE; headers with env interpolation [6] | Not documented beyond the test step |
| **OAuth hand-off** | Provider sign-in in the browser; Claude never sees the password [1] | Authorization prompt, then a tool scan [2] | Browser OAuth; DCR registers a public client [3] | Browser; callback on `127.0.0.1`, `--no-browser` for headless [4] | Browser; accounts appear in the Accounts menu with Sign Out [11] | Browser; Devin Local shows 「Needs authentication」 and 「Authenticate」 re-runs it [7] | — |
| **No DCR** | 「Use your own OAuth client」 [1] | Not documented | Static client in config [3] | `--oauth-client-id`, `--oauth-client-secret` [4] | Asks for Client ID, then Client Secret, in two prompts [10] | Not documented | — |
| **Connecting / success / error** | Not documented beyond 「Connect」 [1] | Tool scan after auth; tool calls error when the app no longer matches its snapshot [2] | Error in chat and 「MCP Logs」 [3] | `/mcp` lists servers and those needing OAuth; 「Authenticate」 [4] | Server output log [5] | 「Needs authentication」 state [7] | 「Test Connection」 lists the tools found before 「Install Plugin」 [9] |
| **Tools listed and toggled** | 「Search and tools」 menu turns tools off; per-tool Always allow / Needs approval / Blocked [1][12] | Admin 「Configure Actions」: new actions off by default; 「Refresh」 rescans tools [2] | Approval per call; admin allowlist [3] | `enabled_tools`, `disabled_tools`, per-tool approval mode [4] | 「Configure Tools」 picker in chat [5][11] | `disabledTools` array [6] | Per tool: run automatically, need approval, or disabled [8] |
| **Disable / reconnect / delete** | Remove from the ⋯ menu; editing means remove and add again [1] | Admin ⋯ › Action control [2] | Toggle in Customize; disabled servers do not load [3] | `enabled = false` keeps it; Restart after edits [4] | ⋯ › Disable / Uninstall; Start, Stop, Restart, Disconnect Account [5][11] | Toggle in Devin Local; refresh [7] | Uninstall from Installed [9] |
| **Sharing** | Owner adds a custom connector for the org; each member connects their own account [1] | Admins publish drafts to the workspace, choose groups [2] | Team admin adds team servers in Dashboard › Plugins & MCPs [3] | Project `.codex/config.toml` [4] | Workspace `.mcp.json` [5] | Team allowlist only [6] | Synced across a person's devices [9] |
| **Mobile** | Connectors added on the web are used from the mobile apps [1] | Web only [2] | Desktop | Desktop | Desktop | Desktop | Desktop and web |

## What Mikka should do at each step, and why

| Step | Mikka | Follows | Why |
| --- | --- | --- | --- |
| Where to add | 插件 › 添加 menu: 「MCP 服务器」 first, then the apps. A server the person added shows in the store's 「MCP 服务器」 section and in 设置 › 连接 | ChatGPT (Plugins › + › Add custom MCP server), Claude (Customize › Connectors › + › Add custom connector) | Both put custom servers in the same place as the catalog, behind the same 「+」. Mikka's 添加 is already that 「+」 (decision 2026-10-31 「插件 is an app store」) |
| Fields | 名称, 服务器网址, 认证 (无 · OAuth · API Key). API Key adds 请求头 and 值 | Claude, LobeHub | Three fields, as Claude. The header name is a choice of the four the backend allows (`mcpAuthSchema`), so it is a select, not a free field |
| Transport | Not asked: Streamable HTTP first, then SSE | Claude, ChatGPT, VS Code (one 「HTTP」 choice) | Only Codex and LobeHub ask, and they also offer stdio, which Mikka does not (#1397 out of scope) |
| Auth choice | The person picks; when they pick wrong, connecting says so (认证失败 or the OAuth fallback) | VS Code, Cursor | Claude pre-detects, which needs a probe before the form; asked in Open questions |
| OAuth hand-off | 连接 opens the provider in a new tab; the dialog shows 「等待浏览器授权」 with 在浏览器中打开 and 取消, and continues on its own when the callback lands | Claude, VS Code; Mikka's own GitHub link flow (`githubLinkWaiting`) | The callback is on Mikka's own origin (#1397), so the dialog can wait for it without a code to paste. The waiting words already exist for GitHub |
| No DCR | The same dialog asks for 客户端 ID and 客户端密钥, and shows the 回调网址 to register | VS Code (asks only when DCR fails), Claude (「Use your own OAuth client」) | Asking only when needed keeps the first form to three fields (R-40) |
| Connecting | 连接 becomes 「正在连接…」, the fields lock | LobeHub 「Test Connection」, ChatGPT tool scan | Saving connects once, as #1397 says; there is no separate test button |
| Success | The dialog closes, the server's page opens, toast 「已连接 Linear」 with 「23 个工具」 | LobeHub (tools shown after the test), ChatGPT (tool scan) | The tool count is the proof it works; the page that lists them is where the person goes next |
| Errors | Under the field they belong to: 网址 无响应, 认证失败（401）. A token that cannot be refreshed: 需要重新连接 on the row and the page, with 重新连接 | Mikka's own `ConnectedAppRow` (需要重新连接 + 重新连接); Devin Local 「Needs authentication」 | Same words and controls as an expired Composio account |
| Tools | The server's page lists 写入 and 读取 groups (by `readOnlyHint`), a switch per tool | Mikka's `ToolGroup` (`control` slot); Claude 「Search and tools」; Codex `enabled_tools`/`disabled_tools` | Mikka already draws tool groups for apps. Approval is not a per-tool setting: writes follow R-77, so there is no allow/ask/deny picker here |
| Disable / reconnect / delete | ⋯ menu on the page: 重新连接, 重命名, 停用 / 启用, 删除 (confirm) | Mikka's account ⋯ menu in `ConnectedAppDetail`; Claude ⋯ › Remove | One menu, same order as apps |
| Sharing | The existing 分享给工作区成员 switch and its confirm dialog (#1186), on the server's page | Claude (owner adds, members use) | Already built and decided; nothing new |
| iOS | 插件 › 应用 lists 「MCP 服务器」 as a native grouped section with a switch per server; a row pushes the server's page (switches per tool, 分享, 重新连接, 删除). No add form on iOS | Claude (add on the web, use on mobile); ChatGPT (web only) | Pasting a URL and a key is desk work, and OAuth needs the browser session the app's keychain cookie is not (`mobile.md` 插件). Asked in Open questions |

## Figma frames

Page 「MCP 服务器 2026-11-05」 (`1002:2`) in `zPe5LKycb2XuT1ivCLRw07`. Each web row is 浅色 1440 · 深色 1440 · 窄屏 390.

| Frame | 浅色 | 深色 | 窄屏 |
| --- | --- | --- | --- |
| E1 入口 · 添加菜单 | `1002:3` | `1002:262` | `1002:129` |
| D1 添加对话框 · OAuth | `1004:223` | `1004:396` | `1004:530` |
| D2 添加对话框 · API Key | `1004:704` | `1004:885` | `1004:1025` |
| S1 连接中 | `1004:1211` | `1004:1379` | `1004:1513` |
| S2 OAuth 交接 | `1004:1688` | `1004:1833` | `1004:1960` |
| S3 无动态注册 · 客户端 ID | `1006:331` | `1006:534` | `1006:688` |
| S4 连接成功 | `1007:614` | `1007:747` | `1007:862` |
| S5a 网址无响应 | `1006:893` | `1006:1064` | `1006:1204` |
| S5b 认证失败 | `1006:1382` | `1006:1567` | `1006:1713` |
| S5c OAuth 授权取消 | `1006:1905` | `1006:2038` | `1006:2154` |
| S5d 服务器要求 OAuth | `1014:2213` | `1014:2365` | `1014:2517` |
| S6 令牌过期 | `1007:1002` | `1007:1134` | `1007:1249` |
| S7 服务器无响应 | `1014:505` | `1014:646` | `1014:787` |
| C1 对话里工具调用失败 | `1014:2676` | `1014:2691` | `1014:2705` |
| P1 服务器页 | `1007:239` | `1007:367` | `1007:479` |
| P5 已停用 | `1014:935` | `1014:1063` | `1014:1191` |
| P2 ⋯ 菜单 | `1008:341` | `1008:473` | `1008:594` |
| D3 编辑对话框 | `1014:1729` | `1014:1888` | `1014:2047` |
| P3 删除确认 | `1008:733` | `1008:881` | `1008:1002` |
| P3b 删除确认 · 已分享 | `1014:1326` | `1014:1458` | `1014:1590` |
| P4 分享确认（#1186） | `1008:1153` | `1008:1299` | `1008:1419` |
| I1 iOS 插件 › MCP 服务器 | `1010:457` | `1010:749` | — |
| I2 iOS 服务器页（推入） | `1010:524` | `1010:816` | — |
| I3 iOS 删除操作表 | `1010:631` | `1010:923` | — |

## Components used (R-90 hand-in)

| Part | Component |
| --- | --- |
| Store, 添加 menu, store items | `PluginsView` `Store` / `StoreItem` / `StoreSection`, `DropdownMenu`, `AppTile` (the `Blocks` fallback glyph), `SearchInput`, `Button` |
| Add dialog | `Dialog` / `DialogContent` (384 wide, `p-4`, the muted `DialogFooter` band, stacked under 640px), `Field`, `Input` (grey fill, no stroke), `NativeSelect`, `ToggleGroup variant="segment"`, the 🔒 安全保护 · Mikka mark from `CredentialDialog` |
| Errors | `FieldError`; a tinted status row (R-87) for whole-dialog states |
| Server page | `PluginBreadcrumb`, `AppTile size="xl"`, `Badge`, `SettingsSection`, `InfoRow`, `SettingRow` + `Switch`, `ToolGroup` with its `control` slot for the per-tool `Switch`, `DropdownMenu` like `ConnectedAppDetail`'s account menu |
| Confirmations | `AlertDialog` `size="sm"` for 删除 (as the store's disconnect), the existing #1186 share `AlertDialog` unchanged |
| Success | `sonner` toast with title and description |
| iOS | Native inset grouped list, `UISwitch`, `UISegmentedControl`, `UINavigationBar` push, `UIAlertController` action sheet (`mobile.md`: native controls) |

No new web component is needed.

## Author self-review against `docs/review-checklist.md`

An independent review (R-84–R-90 step 1) is still owed; this session was told not to start subagents.

| Item | Result |
| --- | --- |
| R-90 reuse | Pass. Every part is listed above. The Figma library's `Dialog` (440, `p-6`, no footer band), `Input` (stroked) and `Toast` (title only) differ from the code; the frames follow the code |
| Usability walk | See the table below. No task left at severity 3 or 4 on the web; adding on iOS is severity 2 and an open question |
| Model (R-01–R-57) | Not affected: 插件 is a full page with no bot list (decision 2026-10-31) |
| R-31 no white hairlines | Pass in dark: dialog, menu and card edges use `border/default` |
| R-30, R-32, R-33 | Pass. Text uses the file's `Mikka/*` styles; those styles are Geist while R-32 says Inter, an existing drift in the Figma file, not new here |
| R-34, R-87 | Pass on the web (header badge: icon, colour, word). iOS 「需要重新连接」 is a red subtitle without an icon, as iOS Settings does |
| R-74 | Pass: every server and app name has its mark first |
| R-40 copy | Pass. No subtitles; status lines name the state. Kept on purpose: 「GitHub 不支持自动注册，需要客户端 ID」 (says why three fields appeared) and 「（可选）」 on the secret |
| R-42 | Not applicable until code; every string is new and goes into `messages/*.json` |
| Completeness | Light, dark, narrow for every web frame. Not drawn because the existing pattern covers them: list loading (`SettingsLoading` skeleton), a server turned off (dimmed row with 已停用, as apps), no servers (the store's MCP 服务器 section is left out) |
| No new polling | The OAuth wait continues on the live channel when the callback lands (`hooks/use-live-key.tsx`), not a timer |
| Same on phone and web | Except adding, which is an open question |

### Walk-through

| Task | Before (main) | After (frames) | Rating |
| --- | --- | --- | --- |
| Add a public server with no auth | Missing: no client calls `POST /api/integrations/mcp` | 插件 › 添加 › MCP 服务器 → 名称, 网址, 认证 无 → 连接 (D1, S1, S4) | Found, 0 |
| Add a server with an API key | Missing | 认证 API Key → 请求头, 值 (D2); wrong key → 认证失败 under the field (S5b) | Found, 0 |
| Add an OAuth server | Missing | 认证 OAuth → provider tab → back to the dialog (S2) → server page (S4) | Found, 1 (the tab opens outside Mikka) |
| Server without dynamic registration | Missing | Same dialog asks for 客户端 ID / 密钥, shows the 回调网址 with copy (S3) | Found, 1 |
| Typo in the URL | — | 无法连接 <host> under 服务器网址 (S5a) | Found, 0 |
| Turn one tool off | Missing | Server page › 工具 › switch per tool (P1) | Found, 0 |
| Token expired | — | 需要重新连接 badge and 重新连接 button on the page (S6), red subtitle on iOS (I1) | Found, 0 |
| Remove a server | Missing | ⋯ › 删除 → confirm (P2, P3); iOS row › 删除 MCP 服务器 → action sheet (I3) | Found, 0 |
| Share with the workspace | Switch in 设置 › 连接 (#1186) | Same switch and confirm, also on the server page (P1, P4) | Found, 0 |
| Add from the phone | Missing | Not offered (I1) | Missing, 2 — open question |

## Review round 1 (Nielsen heuristics, reviewer session)

| Finding | Severity | Outcome |
| --- | --- | --- |
| F1 Authorization takes a raw token, so people paste it without `Bearer` | 3 | Fixed: a fixed 「Bearer」 prefix (`InputGroupAddon`) in front of 值 when the header is Authorization; a pasted `Bearer ` is stripped (D2, S5b, D3) |
| F2 The person must know the auth method in advance | 3 | Fixed: 认证 is preselected from the server's protected-resource metadata and marked 「已自动识别」; it can be changed (D1, D2). If someone overrides it wrongly, connecting says 「此服务器使用 OAuth 登录」 with 「改用 OAuth」 (S5d) |
| F3 No way to change the URL, auth or key | 3 | Fixed: ⋯ › 编辑 opens the same dialog prefilled; a saved key shows as 已保存 and is replaced only when typed; saving connects again (P2, D3) |
| F4 需要重新连接 gives no cause, and a down server needs a different action | 3 | Fixed: a status line with the cause and time (S6 「令牌已过期 · 11月5日 14:02」); S7 for a server that does not answer, with 重新检查. Each cause is a coded error with copy in `RunErrors.*` (decision 2026-11-05-0330) |
| F5 A broken server looks healthy in the web list; the failed call in chat does not lead to it | 3 | Fixed: the store item shows 需要重新连接 (icon, colour, word) (E1); 设置 › 连接 uses the same badge as `ConnectedAppRow`. C1 shows the failed tool call and an 「打开 Sentry」 button |
| F6 「包含 19 个工具…」 repeats the group headings | 2 | Fixed: removed |
| F7 Many tools need many clicks | 2 | Fixed: a switch on each 写入 / 读取 group header. A `SearchInput` above the groups appears past 20 tools; not drawn, Sentry has 19 |
| F8 Disable hidden in ⋯ on the web, a switch on iOS | 2 | Fixed: 启用 is a `SettingRow` switch on the web as on iOS; P5 draws the disabled state |
| F9 iOS switch mixes 启用 and broken | 2 | Fixed: the switch means 启用 only; Context7 is on with the red line (I1) |
| F10 One message for four URL failures | 2 | Fixed: one coded message each — 仅支持公网地址, 找不到 <host>, 连接超时, 这个网址不是 MCP 服务器; S5a draws the first |
| F11 Delete does not say members lose it | 2 | Fixed: P3b when shared |
| F12 No pointer to where a client ID comes from | 2 | Fixed: a 「在 GitHub 创建 OAuth 应用 ↗」 link under the callback URL when the provider's page is known (S3) |
| F13 S5b keeps the typed secret, unlike `CredentialDialog` | 1 | Kept the existing behaviour (cleared on send) so both key forms behave the same; S5b now shows the field empty. Changing both is Alex's call |
| F14 Rail and top bar missing | 1 | Declined: the frames follow the accepted-draft convention of the earlier 插件 page (`773:3`); the column is the same width and position as on main |
| F15 读取 14 shows 5 rows | 1 | Declined: `ToolGroup` lists every tool in a scrolling list (`max-h-96`); the frame shows the top of it |
| F16 Every server has the same icon | 1 | Left to Alex (open question 3); the reviewer recommends the server's own icon with the fallback |
| F17 Dark card outlines read as light lines | 1 | Fixed: outlines use the solid `border/rule` grey instead of white at low opacity (R-31) |

## Open questions for Alex

1. **Detect auth (decided in the draft after review).** The draft now probes the URL and preselects 认证, as Claude does; the reviewer agreed. Confirm.
2. **Name: 「自定义 MCP」 or 「MCP 服务器」?** The section in 设置 › 连接 is 自定义 MCP today (#1186). The draft uses MCP 服务器 everywhere, the word in #1397.
3. **Server icon.** The draft uses the fallback `Blocks` glyph that `AppTile` already draws. The MCP spec lets a server send its own icon; showing it would make rows easier to tell apart.
4. **Adding on iOS.** The draft has no add on iOS. The alternative is a row that opens the web dialog signed in, as app 连接 does today.
5. **A failed key.** Both key forms clear what was typed when it is sent. The reviewer would keep it until the dialog closes so it can be corrected.

## Sources

1. Claude Help Center, 「Getting started with custom connectors using remote MCP」 — https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
2. OpenAI Help Center, 「Connecting custom MCP servers in ChatGPT」 — https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta
3. Cursor docs, 「MCP」 — https://cursor.com/docs/context/mcp
4. Codex docs, 「MCP」 — https://learn.chatgpt.com/docs/extend/mcp?surface=cli
5. VS Code docs, 「MCP servers」 — https://code.visualstudio.com/docs/copilot/customization/mcp-servers
6. Windsurf docs, 「Cascade MCP integration」 — https://docs.devin.ai/windsurf/plugins/cascade/mcp
7. Devin Local docs, 「MCP」 — https://docs.devin.ai/desktop/cascade/mcp
8. LobeHub docs, 「Connectors」 — https://github.com/lobehub/lobehub/blob/main/docs/usage/agent/connectors.mdx
9. Bright Data, 「How to integrate Bright Data Web MCP with LobeChat」 (third-party walkthrough with screenshots) — https://brightdata.com/blog/ai/lobechat-with-web-mcp
10. VS Code docs, 「MCP developer guide」, authorization — https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/ai/mcp.md
11. VS Code release notes 1.101 and 1.102 (Accounts menu, Disconnect Account, server actions, Configure Tools) — https://code.visualstudio.com/updates/v1_101, https://code.visualstudio.com/updates/v1_102
12. Claude Help Center, 「Use connectors to extend Claude's capabilities」 (Always allow / Needs approval / Blocked) — https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
