# Information architecture

What each object is, who owns it, where it is managed and found, and the
navigation tree. Written 2026-11-02 against `main` at `fa4ac2b`, with PRs #890,
#892 and #895 read as in flight.

Sources, higher wins (`README.md`): Alex's decisions, `glossary.md`,
`rules.md`, then code. Tenancy rules T1–T6 are in
[decision 2026-11-02-0230](decisions/2026-11-02-0230-workspace-is-the-tenant.md),
which waits for Alex's confirmation; where it disagrees with a confirmed
decision, this page says so.

Method texts, cited by short name:

| Short name | Text |
| --- | --- |
| IA-n | Uxcel, information architecture audit, framework item n (1 organization scheme … 7 choices and disclosure) |
| NAV | Uxcel, navigation skill (system layering, "keep essentials visible", context table) |
| SET | Uxcel, settings skill (only real settings, group by type, easy to reach) |
| H-n | Nielsen heuristic n, from the Uxcel heuristics audit |
| PM:`id` | ui-ux-pro-max, quick reference § 9 Navigation Patterns, rule `id` |
| SP | `.claude/skills/settings-pages` (section nav, mobile treatment) |
| ID | `.claude/skills/interface-design` ("navigation is the product") |
| DM | domain-modeling skill (glossary format, sharpen fuzzy terms) |
| DDD | domain-driven-design skill (bounded contexts, small aggregates, reference by id) |

Precedent is from the products' public behaviour as known on 2026-11-02, not
re-checked for this page.

## 0. Principle

**A workspace is the tenant; team-only means "exists only between people".**
Members, invitations, teams, roles and 团队权限, member audit, shared credits,
card designation and seats, 分享给团队成员, bots of people who left, and
transfer are team-only (T2). Anything a single person needs to run their own
bots and threads (secrets and environment, Bot 与 Agents, devices, models and
API keys, connections, usage, billing) is present in a personal workspace too.
Alex stated this for settings in 2026-11-02-0216 (PR #895).

## 1. Object model

### Bounded contexts (DDD)

| Context | Holds | Talks to |
| --- | --- | --- |
| Identity | Account, sign-in, security, preferences, notification settings, profile memory | Every context, by account id |
| Tenancy | Workspace, member, invitation, team, roles, policies, audit | Every workspace-scoped context, by workspace id |
| Conversation | Bot (Coordinator included), group chat, chat messages, suggestions | Work (dispatches threads, creates tasks) |
| Work | Task, project, thread, Artifact, acceptance | Execution (a thread runs on a machine) |
| Execution | Agent, device, Mikka Cloud and bot computers, secrets injected at run start, execution rules | Billing (charges), Identity (credentials) |
| Credentials | Model subscriptions, API keys, E2B key, saved logins, connections | Execution (resolved per run), Tenancy (shares) |
| Billing | Credits, allowance, usage, plan, card designation, credit shares | Tenancy (the paying workspace) |

### Aggregates and owners

"Owner" is the account or workspace the row is keyed by. Small aggregates,
referenced by id (DDD).

| Object | What it is | Aggregate · owner | Stored (owner columns) | Created | Managed | Found |
| --- | --- | --- | --- | --- | --- | --- |
| Account | The person | Account · itself | `user`; `user_preferences.userId` (`lib/db/schema.ts:1090`) | Sign-up | 设置 › 账户, 安全, 偏好设置 | Rail avatar → account menu (R-75) |
| Workspace | The tenant (T1) | Workspace · owner account | `mikka_workspaces.userId`, `kind` personal/team (`lib/db/workspace-schema.ts:4-14`) | Personal: on first use (`lib/personal-workspace.ts:16-26`); team: 创建工作区 (`app/actions/workspace.ts:49`) | 设置 › 常规 | Account menu, the only switcher (R-75, R-79) |
| Member | An account's place in a workspace | Workspace · workspace | `mikka_workspace_members (workspaceId, userId, role, status)` (`workspace-schema.ts:16-24`) | Invitation, team only (`app/actions/workspace.ts:91`, refuses personal at `:100`) | 设置 › 成员 | 设置 › 成员 |
| Team (团队) | A group inside a team workspace | Team · workspace | `mikka_teams.workspaceId` (`lib/db/team-schema.ts:3-9`) | 设置 › 团队 › 创建团队 (`app/actions/teams.ts:47`) | 设置 › 团队 | 看板 (R-82); 设置 › 你的团队 |
| Bot | Chats, dispatches threads | Bot · workspace, held by owner | `bots (ownerId, workspaceId, archivedAt)` (`schema.ts:95-115`) | 新建 Bot (`app/actions/bots.ts:45` → `lib/bot-create.ts:14`) | 概览 header (name, look; R-51); defaults in 设置 › Bot 与 Agents | Bot list (R-01); ⌘K |
| Coordinator | The person's ordinary bot in a workspace (R-06) | Bot · workspace, one per person | `coordinator_bots (ownerId, workspaceId) → bots` (`schema.ts:117-122`; `lib/coordinator/coordinator-bot.ts:5-16`) | On first use | As any bot | Bot list, pinned |
| Group chat | Chat with several bots and people | Conversation · workspace | `conversations.workspaceId`, `createdBy`; `conversation_members` (`schema.ts:822-836`) | Bot list 「+」 | Group panel | Bot list; ⌘K |
| Agent | Coding worker that runs a thread | Agent · account | `agents.userId`, `deviceId` (`schema.ts:321-328`); choice per person per workspace in `execution_rules (ownerId, workspaceId)` (`schema.ts:126-131`) | Detected on a device | 设置 › Bot 与 Agents | Its mark on 全部线程 rows (R-78) |
| Thread (run) | Work a bot dispatched | Thread · workspace of its bot | `agent_runs.userId`, `botId`, `issueId` (`schema.ts:338-398`); no `workspaceId`, reached through `bots.workspaceId` | Dispatched from chat | Its column: 对话, 验收 | 概览 › 线程; 全部线程; chat card; task's 线程 (R-82) |
| Task (issue) | Work to be done (`MIK-xx`) | Task · workspace (team: its team) | `issues.userId`, `scope` (`schema.ts:30-45`); team tasks in `mikka_team_issues (teamId, workspaceId)` (`team-schema.ts:15-18`) | By a bot in chat, or 新建任务 (R-22) | Task page | 看板; ⌘K; chat chips (R-15) |
| Project | A group of tasks | Project · account, linked to teams | `workspace_projects.userId` (`lib/db/project-schema.ts:4-6`); `mikka_team_projects.workspaceId` (`team-schema.ts:29-32`) | 看板 › 项目 | Project page | 看板 (R-82); ⌘K |
| Artifact | What a thread produces to look at or accept | Artifact · account, linked to run | `artifacts.userId`, `runId`, `issueId` (`schema.ts:893-904`) | By a thread | Artifact window (R-56) | Artifact rail page; thread header 「Artifact · N」 |
| Device | The person's computer or server | Device · account | `devices.ownerId` (`schema.ts:248-262`) | Daemon registration (`app/v1/devices/register/route.ts:41`) | 设置 › 设备 | 设置 › 设备 |
| Bot computer (电脑) | A bot's cloud computer | Bot · workspace | `bot_desktops`, `bot_cloud_runtimes (botId, workspaceId, ownerId)`; `cloud_machines (workspaceId PK, ownerId)` | With the bot (R-04) | — | 概览 › 电脑 |
| Connection | Link to an outside app | Connection · account | `composio_accounts.userId` (`schema.ts:727-741`), `github_connections.userId` (`:399`), `linear_connections.userId` (`:169`), `telegram_links` | 插件 › an app | 插件, and 设置 › 连接 (same `PluginsView`) | 插件 rail page |
| App policy | What members' connections may do here | Workspace · workspace | `workspace_app_policies.workspaceId` (`lib/db/app-policy-schema.ts:4`) | — | 设置 › 团队权限 | 设置 › 团队权限 |
| Secret / env var | Value injected into the workspace's runs | Secret · workspace | `workspace_secrets (workspaceId, scopeType, scopeRef, createdBy)` (`lib/db/secrets-schema.ts:8-23`); injected by `loadWorkspaceRuntimeSecrets` (`lib/secrets/runtime.ts:20`) | 设置 › 密钥与环境 (`lib/secrets/store.ts:124`) | 设置 › 密钥与环境 | 设置 › 密钥与环境 |
| Model credential | Subscription login or API key | Credentials · account | `byos_connections.ownerId` (+ legacy `workspaceId`), `model_api_keys.ownerId`, `user_e2b_keys.userId`; shares `workspace_subscription_shares`, `model_api_key_shares` (drizzle `20261027164503`, `20261101021000`, `20261101020201`) | 设置 › API 与订阅 | 设置 › API 与订阅 (shares: team only) | 设置 › API 与订阅; bot model chip (R-11) |
| Credits, allowance, billing | What a workspace spends and pays | Billing · workspace | `workspace_billing`, `workspace_credit_grants` (`schema.ts:1151-1180`), `hosted_allowances`, `hosted_usage` (drizzle `20261030230000`); `workspace_payment_designations`, `workspace_credit_shares` (team) | Stripe webhook (`lib/billing/service.ts:145`); allowance on verification | 设置 › 用量, 计费 | 设置 › 用量, 计费 |
| Notifications | Pushes and alerts about runs and chats | Account · account | `user_preferences` switches (`components/settings/notifications-settings.tsx:9`), `mobile_push_tokens.userId` (`schema.ts:1071`) | — | 设置 › 通知 | Web: none; desktop: system notification and Dock badge for 等你 (`platforms.md`); phone: push |
| Memory | Facts about the person | Account · account | `user_facts.userId` (`schema.ts:664`) | Extracted from chats | 设置 › 记忆与建议 | 设置 › 记忆与建议 |

Not determined from code: where bot memory and team memory are stored
(decision 2310 keeps them in their workspace; no table for them was found), and
how a personal task (`issues.scope = 'personal'`) is tied to one workspace,
since `issues` has no `workspaceId`.

## 2. Ownership and lifecycle (workspace area)

Each cell cites the code path; "not implemented" means no code path exists.

| Object | Created by | Belongs to | Changed by | Transfer | Delete | Owner leaves a team workspace | Owner deletes the account (personal workspace) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Personal workspace | System, first use (`lib/personal-workspace.ts:16-26`) | Its account | Owner (admin of it) | Never (#895: `general.ts` `mayTransfer`) | Never (#895: `workspacePersonalDelete`) | n/a, one member | Workspace DB rows go (`lib/account/delete.ts:110-119`); main-DB rows keyed only by workspace (`workspace_secrets`, `workspace_billing`, `workspace_settings`, `hosted_allowances`) are not swept: the sweep matches owner columns only (`delete.ts:32`, `:180`), and `workspace_secrets` has `createdBy` |
| Team workspace | Any account (`app/actions/workspace.ts:49`) | Owner account (`mikka_workspaces.userId`) | Admins (`lib/workspace-admin/general.ts:44`) | Owner, or an admin when the owner is no longer an active admin (`general.ts:78-85`, `:114-134`); only `workspaces.userId` changes | Admin, typed name (`general.ts:215-250`); leaves `workspace_secrets`, `workspace_e2b_keys`, `workspace_app_policies`, `workspace_personal_policies`, `workspace_subscription_shares`, `model_api_key_shares`, `workspace_credit_shares`, `workspace_payment_designations`, `hosted_allowances`, `execution_rules`, `bot_model_choices`, `personal_access_tokens` (`deleteAppData`, `general.ts:170-213`) | Last active admin cannot be removed (`members.ts:117-121`) | Refused while they are its only active admin (`delete.ts:96-100`); otherwise membership goes (`delete.ts:121-122`) |
| Member | Invitation accepted (`workspace.ts:164`) | Workspace | Admins: role, suspend (`workspace.ts:122-147`) | n/a | Admin removes (`members.ts:133-155`); not themselves (`:135`); self-leave not implemented, though `workspaceCannotRemoveSelf` copy names 「离开工作区」 (`messages/zh-CN.json:1160`) | Removed or suspended | Membership rows deleted (`delete.ts:121-123`) |
| Team | Any member (`app/actions/teams.ts:47-60`, no admin or kind check) | Workspace | Team admins (`teams.ts:56`) | Not implemented | Typed name (`lib/workspace-admin/teams.ts:57-80`) | Their team memberships go (`members.ts:146`) | Team memberships go (`delete.ts:121`); a team they created stays |
| Bot | Owner (`lib/bot-create.ts:14`) | Workspace, held by owner | Owner (`lib/bot-update.ts:19`); defaults by admins (`lib/workspace-admin/bots.ts:59`) | On removal or suspension to a named member, or admin takeover (`members.ts:45-66`, `:94-107`); Coordinator never (`:40-43`); threads keep `agent_runs.userId` of the old owner | Not implemented for one bot; only with its workspace (`general.ts:192`) or account | Paused, `archivedAt` (`members.ts:72-86`); restored on reactivation (`:89-91`) | Deleted with every `ownerId` row (`delete.ts:17-21`), in shared workspaces too, unlike leaving |
| Agent | Device report | Account (`agents.userId`) | Owner | n/a | With its device or account | Unaffected; the person's per-workspace choice stays in `execution_rules` | Deleted (owner column) |
| Device | Daemon (`app/v1/devices/register/route.ts:41`) | Account | Owner | Not implemented | Owner (`app/actions/agents.ts:146`) | Unaffected; it runs only its owner's bots (2240) | Deleted (owner column) |
| Connection | Owner (`lib/composio-account-store.ts:35`) | Account | Owner | n/a | Owner | Unaffected; admin app policy governs only sharing (2240) | Deleted (owner column) |
| Secret / env var | Admin: any scope; member: repository scope (`lib/secrets/permissions.ts:14-25`) | Workspace | Admins; members may replace repository entries (`permissions.ts:17`) | n/a | Admins only (`permissions.ts:19`, `store.ts:179`) | Stays, it is the workspace's | Personal workspace: not deleted (see first row) |
| Model credential | Owner | Account | Owner | n/a | Owner | Shares in that workspace deleted, runs on them stopped (`members.ts:76-85`) | Deleted (owner column) |
| Credits, billing | Stripe webhook (`lib/billing/service.ts:145`) | Workspace | Admins (计费) | n/a | With the workspace, refused while a subscription is live (`general.ts:172`) | Their card designation released with a grace period (`members.ts:74`), credit share deleted (`:78`) | Personal workspace's billing rows remain (see first row) |

## 3. Model vs implementation

Severity: P0 blocks a key task or loses data; P1 frequent or a security,
credential or data-retention risk; P2 friction or drift. Occurrence × impact
per AGENTS.md triage is in brackets.

| # | Where | Model says | Code does | Impact | Change | Sev |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | `lib/settings-sections.ts:94` | Bot 与 Agents, 常规, 密钥与环境 are workspace-level (T2; 0203, 0216) | `TEAM_ONLY_SECTIONS` hides them in a personal workspace | A single person cannot set run secrets or bot defaults [9×7] | Fixed by #890 (Bot 与 Agents) and #895 (常规, 密钥与环境) | P0 |
| M2 | `lib/account/delete.ts:17-21`, `:180` | Bots of people who leave a team are paused for takeover (T2; 2225 rule 6) | Account deletion deletes the person's bots and their threads in shared workspaces | Team loses bots and run history on team tasks, irreversibly [3×8] | Before the sweep, run `releaseDepartingMember` for shared workspaces and keep bots and runs there | P1 |
| M3 | `lib/workspace-admin/general.ts:170-213` | Deleting a tenant deletes everything keyed by it (T5) | `deleteAppData` leaves secrets, E2B keys, policies, shares, payment designations, allowances, execution rules, PATs | Encrypted secret values outlive their workspace [4×7, credential retention] | Delete every main-DB table with a `workspaceId` column; a test that lists them from `information_schema` as `delete.ts` does | P1 |
| M4 | `lib/account/delete.ts:32`, `:180` | Deleting an account deletes its personal workspace (T1, T5) | Main-DB rows keyed only by `workspaceId` (or `createdBy`) stay | Same retention as M3 for every deleted account [5×7] | Run the M3 deletion for each solo workspace in the account plan | P1 |
| M5 | `app/actions/teams.ts:47-60` | Teams are team-only (T2) | `saveTeam` checks membership only: no admin check, no `kind` check | A personal workspace can hold a team through the API; UI hides it [2×3] | Refuse `kind = 'personal'` with `workspacePersonal`, as invitations do | P2 |
| M6 | `lib/settings-sections.ts:46` vs `lib/secrets/permissions.ts:14-25` | Members may write repository-scoped secrets | The section is `adminOnly`, so members never reach it | Members' allowed action has no page [4×3] | Show 密钥与环境 to members with their scope only | P2 |
| M7 | `lib/workspace-admin/members.ts:135`, `zh-CN.json:1160` | A member can leave (2225 rule 6) | No leave action; the error copy names 「离开工作区」 | Copy promises a missing action [3×3] | Build 离开工作区 on `releaseDepartingMember`, or drop the copy | P2 |
| M8 | `components/settings/team-permissions-settings.tsx:55-58` | An admin can switch off only 分享给团队成员 (2240) | The row is 「允许成员使用个人订阅和 API Key」 (`workspace_personal_policies.subscriptions`) | Label claims a switch 2240 removed; behaviour not verified here [3×4] | Rename to what it does, or remove | P2 |
| M9 | `byos_connections.workspaceId` (drizzle `20261027164503`) | Subscriptions belong to the account (2225 rule 2, T6) | The binding row still carries a workspace | Two sources of truth for where a subscription runs [2×3] | Resolve by owner only; keep sharing in `workspace_subscription_shares` | P2 |
| M10 | `lib/personal-workspace.ts:35-40` | Own credentials need no share (2240) | `ensurePersonalShare` writes a share row for the personal workspace | Redundant row; harmless [1×1] | Drop when the resolver no longer reads it | P2 |
| M11 | `lib/workspace-admin/general.ts:114-134` | Transfer hands the workspace on | Only `workspaces.userId` changes; `cloud_machines.ownerId` and the Stripe customer stay with the old owner | Undefined who pays for the workspace's Mikka Cloud machine after transfer [2×4] | Decide with Alex; `cloud_machines` is one row per workspace while E2B keys are personal | P2 |
| M12 | `members.ts:45-66` | A taken-over bot runs on the new owner's resources | `agent_runs.userId`, `execution_rules`, `bot_model_choices` keep the previous owner | New owner's view of the bot's threads depends on `userId` reads [2×3] | Check `canReadThread` for taken-over bots | P2 |
| M13 | `personal_access_tokens (userId, workspaceId)` in 账号 group (`settings-sections.ts:40`) | Account-level objects are stored once (T6) | Tokens are per workspace, listed as an account setting | Unbuilt; decide before shipping | Either a workspace setting or an account token | P2 |

**Verdict.** The principle holds: every capability a single-member workspace
needs (bots, Agents choice, secrets, usage, billing) is keyed by workspace in
the schema, and every team-only capability (members, teams, roles, audit,
shares, designations, transfer) is about another person. The conflicts are in
lifecycle, not in visibility: account deletion breaks bot ownership in teams
(M2), and tenant deletion leaves workspace data behind (M3, M4). Per-person
rows stored per workspace are either shares (correct, T6), per-person
preferences inside a tenant (`execution_rules`, `bot_model_choices`,
`coordinator_bots`: correct), or drift (M9, M13).

## 4. Settings ownership

Levels: **Account** (same in every workspace), **Workspace** (personal and
team), **Team-only**. Each row cites the glossary term (§ glossary, domain
terms) and tenancy rule.

| Section (id) | Level | Term · aggregate | Rule | Code on main | Reason |
| --- | --- | --- | --- | --- | --- |
| 账户 (`account`) | Account | Account | T6 | Account | Identity |
| 安全 (`security`) | Account | Account | T6 | Account | Sign-in |
| 偏好设置 (`preferences`) | Account | Account | T6 | Account; 重新播放引导 moves here (#890) | The person's own |
| 通知 (`notifications`) | Account | Account | T6 | Account | The person's pushes |
| 记忆与建议 (`memory`) | Account | Account (profile memory) | T6; 2310 | Account | Facts about the person |
| 连接 (`connections`) | Account | Connection | T6; 2240 | Account | Runs only the owner's bots |
| API 与订阅 (`models`) | Account; 分享给团队成员 team-only | Model credential; share | T6, T2 | Matches (`settings-view.tsx:153`) | Credential is the person's, the share is between people |
| 登录与密钥 (`logins`) | Account | Account | T6 | Account | Saved logins are the person's |
| 数据与隐私 (`privacy`) | Account | Account | T6 | Account | Export and deletion of the person |
| 设备 (`computers`) | Account | Device | T6 | Account | The person's machines |
| 个人访问令牌 (`developer`, unbuilt) | Open | — | T6 vs storage | Unbuilt; stored per workspace (M13) | Decide before shipping |
| 常规 (`general`) | Workspace; 转让 and delete team-only | Workspace | T1, T2 | Team-only; fixed by #895 | Name, icon, address are the tenant's; transfer is between people |
| 成员 (`members`) | Team-only | Member | T2 | Team-only | Between people |
| 团队 (`teams`) | Team-only | Team | T2 | Team-only (server gap M5) | Between people |
| Bot 与 Agents (`bots`) | Workspace; 已暂停的 Bot team-only | Bot, Agent | T1, T2 | Team-only; fixed by #890 | A person's bots need defaults; bots of people who left are a team's |
| 团队权限 (`permissions`) | Team-only | Workspace (policies) | T2 | Team-only | Governs sharing with other members (2240) |
| 密钥与环境 (`secrets`) | Workspace | Secret | T5 | Team-only, admin-only; fixed by #895 (members gap M6) | Injected into the workspace's own runs |
| 审计日志 (`audit`) | Team-only | Workspace (audit) | T2 | Team-only | Member audit is between people |
| 用量 (`usage`) | Workspace | Credits | T4 | Workspace | The tenant's spend |
| 计费 (`billing`) | Workspace; 付款 team-only | Credits, billing | T4, T2 | Matches (`settings-view.tsx:131`) | The tenant pays; card designation and credit share are between people |

Placement guidelines used: SET "only real settings belong here" and "group
related settings by type" (account group vs workspace group); IA-7 (show few
options: a personal workspace hides only what cannot apply); PM:`empty-nav-state`
(a destination that does not apply is explained, not silently hidden: the
personal 常规 row 「个人工作区不能删除」 in #895).

## 5. Navigation tree

### Organization, labeling, navigation, search (IA-1…IA-7)

| System | Mikka | Note |
| --- | --- | --- |
| Organization | Topical by object: bots (left), the chat (centre), threads (right); rail pages by kind (建议, 看板, 插件, Artifact) | IA-1: object-oriented matches the tasks "talk to a bot", "check work" |
| Labeling | § 6 | IA-3 |
| Navigation | Global: window bar and rail. Local: bot list, settings sections, 概览 tabs. Contextual: chat cards and chips | NAV "layer the systems" |
| Search | ⌘K over bots, chats, group chats, tasks, projects (`components/nav/global-search.tsx`, `lib/site-search.ts:14-16`); not threads, Artifacts or settings | IA-5: known-item search misses two primary objects |

### Web, desktop width (≥ 1280px)

```
Window bar (44px, R-35)
├── ← →                         history (R-82)
├── ⌘K search pill              global
├── [打开右栏]                   when the right column is closed
├── 全部线程                     target, top bar global entry (in progress, another session)
└── 浏览器 globe                 R-57
Icon rail (68px, icons only, R-35)
├── 主页 ─ bot list | chat | right column
├── 建议 ─ cards | Coordinator chat (R-55)
├── 看板 ─ tasks, projects, teams (R-82)
├── 插件 ─ apps, skills
├── Artifact ─ categories | table (R-56)
├── 重启以更新                   desktop app only
└── avatar ─ account menu: accounts, workspaces, 创建工作区, 设置, 添加账户, 退出登录 (R-75)
Card
├── Bot list (left): bots, group chats; 新建 Bot (R-01)
├── Centre: chat, or a task page, or a rail page
└── Right column (R-50, R-82), one of:
    ├── 概览: bot header, tabs 详情 / 线程 / PR / 电脑
    ├── 全部线程 (current: the second pill of this header, components/nav/context-panel.tsx:171)
    ├── a thread: 对话 / 验收, composer at the bottom, ended or not (#892)
    └── 浏览器
设置 (same frame, R-35; /settings?section=…, /settings/members, /settings/teams)
├── 账号: 账户 · 安全 · 偏好设置 · 通知 · 记忆与建议 · 连接 · API 与订阅 · 登录与密钥 · 数据与隐私 · 设备
├── <workspace name>: 常规 · 成员* · 团队* · Bot 与 Agents · 团队权限* · 密钥与环境 · 审计日志* · 用量 · 计费   (* team-only)
└── 你的团队: one row per team, 创建团队 (team workspace only)
```

### Narrow desktop (768–1279px) and phone web (< 768px)

| Element | ≥ 1280 | 768–1279 | < 768 (phone web) |
| --- | --- | --- | --- |
| Window bar (back, ⌘K, panel, globe) | Shown | Shown | Hidden (`components/app-shell.tsx:55`, `md:grid`) |
| Icon rail | Shown | Shown | Hidden (`icon-rail.tsx:52`); its items move to the bot list's footer with the account menu (`bot-list.tsx:184-187`) |
| Bot list | Column, collapsible | Column, collapsible | Off-canvas sheet behind the header button |
| Right column (概览, 全部线程) | Inline (`context-panel.tsx`, `xl:flex`) | Sheet over the content (`issue-workspace.tsx:180`) | No opener: `openPanel` is called only from the window bar (gap G2) |
| Conversation pill | Shown | Shown | Hidden (`conversation-pill.tsx`, `md:flex`) |
| Search | Pill in the window bar | Pill | Header search icon, except on 插件, 建议, Artifact |
| Settings sections | Column | Column | Sheet with the rail items at its foot (`settings-sidebar.tsx`, SP "mobile treatment") |

### Desktop app (Electron, same UI)

Differs only in: window bar padding for the macOS traffic lights and drag
region; translucent frame; 重启以更新 above the avatar; system notifications
when a run enters 等你 or fails, and a Dock badge with the count of runs
waiting for the person; clicking a notification opens the task
(`platforms.md`). No second settings surface.

### Native iOS app (for comparison)

Tab bar 对话 · 线程 · 搜索; drawer for 设置, 建议, 任务, 插件 (`mobile.md`).
Threads are a top-level tab there: the web is the only client where all
threads sit inside a bot's panel.

### Global entries (reachable from anywhere)

| Entry | Now | Target |
| --- | --- | --- |
| ⌘K search | Window bar pill and ⌘K; settings pill asks the app to open it (`lib/settings-navigation.ts`) | Also threads, Artifacts and settings sections (G3) |
| 全部线程 | Pill inside the right column's header | Top-bar entry, opens in the right column beside the centre (R-82); in progress in another session |
| 等你 inbox / notifications | Web: none. `inbox` section (收件箱, followed tasks) exists in `workspace-navigation.ts:12` and `workspace-overview.tsx:28` but nothing opens it; `components/app-sidebar.tsx` that linked it is imported nowhere | Rule: the top-bar 全部线程 entry carries the 等你 count, the same number as the desktop Dock badge (heuristic "visibility of system status"; built in the top-bar 全部线程 PR) |
| 设置 | Account menu and ⌘, (R-75) | Unchanged |
| Workspace switch | Account menu only (R-75, R-79) | Unchanged |

## 6. Labeling

### Canonical names (`messages/zh-CN.json`, `messages/en.json`)

| Object or entry | 中文 | English |
| --- | --- | --- |
| Account (level) | 账号 | Account |
| Account (settings page) | 账户 | Account |
| Workspace | 工作区 | Workspace |
| Personal workspace | 个人工作区 | Personal workspace |
| Team workspace | 团队工作区 | Team workspace |
| Team (inside a workspace) | 团队 | Team |
| Member | 成员 | Member |
| Bot list / thread list | Bot / 线程 | Bots / Threads |
| Chat | 对话 | Chat |
| Thread | 线程 | Thread |
| All threads | 全部线程 | All threads |
| Task / board | 任务 / 看板 | Task / Board |
| Artifact | Artifact | Artifact |
| Agent | Agent | Agent |
| Bot computer / local browser | 电脑 / 浏览器 | Computer / Browser |
| Device | 设备 | Device |
| Connection / plugin store | 连接 / 插件 | Connections / Plugins |
| Secrets and environment | 密钥与环境 | Secrets and environment |
| API and subscriptions | API 与订阅 | API and subscriptions |
| Credits / free allowance / subscription quota | 点数 / 免费额度 / 订阅额度 | Credits / free allowance / subscription quota |
| Usage / billing | 用量 / 计费 | Usage / Billing |
| Right panel / overview | 右栏 / 概览 | Right panel / Overview |

### Inconsistencies (same thing, different names)

| # | Where | Names | Fix |
| --- | --- | --- | --- |
| L1 | Glossary, settings | 团队 is both the team workspace (decision 2310 prose) and a team inside a workspace (设置 › 团队, `mikka_teams`) | 团队工作区 for the tenant, 团队 only for the group (DM "sharpen fuzzy language") |
| L2 | `lib/settings-sections.ts:44` vs `en.json` | "Bots and agents" (search title) vs "Bots & Agents" | One string; the search reads `title` |
| L3 | `settings-sections.ts` vs `zh-CN.json` vs `mobile.md` | "Memory" vs 记忆与建议 vs 记忆; 建议 is also a rail page | 记忆 for the section (ChatGPT, Claude) |
| L4 | Settings vs rail vs `docs/settings.md` | 连接 vs 插件 vs "Integrations" for the same `PluginsView` | Keep 插件 for the store, 连接 for linked apps; fix `docs/settings.md` |
| L5 | Section id `models`; decisions 2130, 2225; `Coordinator.subscriptionRefusal.open` | 「API 与订阅」 vs 「模型与额度」, which the Coordinator's refusal card still shows as its link | 「API 与订阅」 in the string; old decisions are history |
| L11 | `Billing.allowance.section`, `Settings.apiKeys.afterQuota` | 额度 means both the free allowance and a subscription's quota | 免费额度 and 订阅额度, never bare 额度 |
| L6 | Settings group vs page vs menu | 账号 (group), 账户 (page), 「账户菜单」 (menu that also switches workspaces) | Menu label 账号菜单 |
| L7 | `zh-CN.json` `Nav.workspace` (`components/nav-main.tsx:43`) | 工作空间 vs 工作区 | 工作区 (C-06) |
| L8 | `Nav.inbox` / `Overview.followingTitle` | 收件箱 opens 关注的任务活动 | Name it for what it shows, or remove with G5 |
| L9 | 团队权限 | 「允许成员使用个人订阅和 API Key」 vs 2240's 分享给团队成员 | M8 |
| L10 | `docs/settings.md` § Sections | Profile, Workspace, Integrations vs 账户, 常规, 连接 | Use the UI names (C-06) |

## 7. Placement principles

| # | Rule | From |
| --- | --- | --- |
| P1 | A setting is team-only only if it concerns another person. | T2; Linear, Notion, GitHub, Vercel keep members, roles and audit on the team or organization and give a single user the rest |
| P2 | What is bound to the person is stored and shown once, at the account level, the same in every workspace; it enters a workspace only by an explicit share. | T6; ChatGPT and Claude (personal settings separate from workspace admin); GitHub (user PATs and SSH keys vs organization settings) |
| P3 | A capability a run needs (secrets, environment, Agent and model defaults) exists wherever runs exist, so in every workspace. | T5; GitHub repositories have Actions secrets and environments in personal and organization accounts alike; Vercel Hobby projects have environment variables |
| P4 | Anything a person checks daily is one click from anywhere: in the window bar or the rail, never inside one bot's panel. | NAV "keep essentials visible"; PM:`persistent-nav`; Linear Inbox and My issues, Slack Activity, GitHub notifications in the header |
| P5 | Every list a bot's panel shows has a global equivalent, except the bot's computer (R-04). | IA-5 (multiple paths); the iOS app's 线程 tab |
| P6 | Every primary object is findable by ⌘K: bots, chats, tasks, projects, threads, Artifacts, settings sections. | IA-5 known-item search; PM:`search-accessible`; Linear and GitHub command palettes; Notion search over pages and settings |
| P7 | One object opens in one place, whatever the entry point. | R-82; NAV "always answer where am I" |
| P8 | A destination that does not apply in this workspace says why in one status line instead of vanishing, when someone may look for it. | PM:`empty-nav-state`; H-1; R-40 (state only) |
| P9 | Phone web keeps every global entry: what the window bar holds moves to the header or the list footer. | PM:`persistent-nav`, `adaptive-navigation`; NAV "never bury primary sections behind a hamburger when space allows" |
| P10 | One word per object across UI, settings and docs; the glossary decides. | IA-3; H-4; C-06; DM |

## 8. Gaps (current vs target)

| # | Gap | Where | Sev | Breaks | Change | Status |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | Bot 与 Agents, 常规, 密钥与环境 hidden in a personal workspace | `lib/settings-sections.ts:94` | P0 | P1, P3; T2, T5 | Remove from `TEAM_ONLY_SECTIONS` | #890, #895 |
| G2 | Phone web cannot open the right column: no 概览, no 全部线程, no bot threads, PR or 电脑 | `issue-workspace.tsx:180`, `:448`; window bar hidden below `md` | P1 | P9; PM:`persistent-nav` | A header button on phones, as the iOS app's bot page; verify in a browser at < 768px (found from code only) | Open |
| G3 | 全部线程 sits inside one bot's panel | `context-panel.tsx:171` | P1 | P4, P5; NAV | Top-bar global entry | In progress (another session) |
| G4 | ⌘K finds no threads, Artifacts or settings sections | `lib/site-search.ts:14-16`, `global-search.tsx` | P1 | P6; IA-5 | Add the three sources | Open |
| G5 | No web inbox for 等你; dead `inbox` section and unused `components/app-sidebar.tsx` | `workspace-navigation.ts:12`, `workspace-overview.tsx:28` | P2 | P4; H-1 | Count on the 全部线程 entry (decided, built in the top-bar 全部线程 PR); remove the dead section and file | Open |
| G6 | 重新播放引导 lived in 常规, a team setting | `workspace-settings.tsx` | P1 | P1 | Move to 偏好设置 | #890 |
| G7 | An open ended thread had no composer | `issue-thread-panel.tsx` | P1 | R-10 | Composer everywhere a thread opens | #892 |
| G8 | Members cannot reach their repository-scoped secrets | M6 | P2 | P3 | Member view of 密钥与环境 | Open |
| G9 | Account deletion deletes team bots; workspace and account deletion leave tenant data | M2, M3, M4 | P1 | T2, T5 | Decided in [0230](decisions/2026-11-02-0230-workspace-is-the-tenant.md) Consequences: pause and keep in shared workspaces; delete all tenant rows. Separate PRs | Open |
| G10 | Label drift L1–L10 | § 6 | P2 | P10 | Fix strings and docs | Open |
| G11 | A bot's PR tab has no global list | `context-panel.tsx` PR tab | P2 | P5 | 全部线程 rows already link PRs through tasks; a global PR list only if Alex wants one (GitHub precedent) | Ask Alex |

## 9. Precedent

| Product | Personal | Workspace or team | Global entries |
| --- | --- | --- | --- |
| Linear | Account: profile, preferences, notifications, security, personal API keys | Workspace: general, members, billing, security, integrations; teams have their own settings | Inbox, My issues, ⌘K in the sidebar |
| Notion | My account, My settings, My notifications, My connections | Workspace settings, people, teamspaces, billing, security; a single-person workspace has the same workspace settings | Search, Inbox at the top of the sidebar |
| Slack | Preferences and profile per person | Workspace admin in a separate admin site | Activity, DMs, Later in the rail; search in the top bar |
| Vercel | A Hobby account has projects, environment variables, domains, tokens, usage | Teams add members, roles, access groups, audit log | Search and notifications in the header |
| GitHub | User settings: profile, SSH and GPG keys, PATs, notifications, billing; a personal repository has secrets and environments | Organizations add members, teams, roles, audit log, organization secrets | Notifications inbox and search in the header, command palette |
| ChatGPT | Settings: general, notifications, personalization and memory, connectors, data controls, security | Workspace settings for admins: members, billing, permissions | Search chats, projects, library in the sidebar |
| Claude | Settings: profile, appearance, account, privacy, billing, capabilities and memory, connectors | Organization settings for admins: members, billing, data | Search, projects, Artifacts, recents in the sidebar |
