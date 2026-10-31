# Personal vs workspace: who owns what

- **Status:** research and proposal, pending Alex's approval
  ([draft decision](../decisions/2026-10-31-2130-personal-vs-workspace.md))
- **Date:** 2026-10-31, audited at `a12adc3`
- **Why:** many bugs come from unclear ownership between 个人 and 工作区. The
  latest: 设置 › 工作区 › Bot 与 Agents showed 「未连接账号」 on every bot.
  Alex: bots belong to a person, and 「不管你在哪个工作区，你都可以用自己账号」.
  Direction relayed by the coordinator: copy OpenAI's and Anthropic's model,
  where each person has a personal workspace and team workspaces sit beside it.

## 1. The rule (proposal)

1. **Three levels, no more.**
   - **Account:** who you are, and what you sign in with or bring: your
     identity, credentials, devices and preferences. These follow you into
     every workspace.
   - **Personal workspace:** one per person, created with the account, with
     only you as a member. Your own bots, threads and billing live here.
   - **Team workspace:** members, shared settings, policies, secrets and
     billing.
2. **Credentials are account-level, resources are workspace-level.** A
   subscription login, an app connection, a saved login or a device belongs
   to the person. Bots, threads, repositories, secrets, the E2B key and
   points belong to a workspace, and every bot has one owner (the person who
   made it).
3. **A credential only runs for its owner.** My Claude subscription, my Gmail
   and my saved logins run only my bots, in any workspace I belong to, and
   never another member's bot. This rule already holds for apps
   (decision 2026-10-31 「App connections belong to the person」) and for
   saved logins (2026-10-27). Subscriptions join them.
4. **The workspace limits personal items without owning them.** An admin can:
   - switch off an app, a device type, or personal subscriptions, for that
     workspace only;
   - cap points.

   An admin never sees or uses a member's credential. Everything is on by
   default (decision 2026-10-31 「every feature is on by default」).
5. **Whose quota pays:**
   - a personal subscription pays with the owner's own plan quota;
   - Mikka 默认 (the hosted model) and Mikka Cloud pay with the workspace the
     run belongs to;
   - work with no workspace of its own (the Coordinator's background jobs,
     memory extraction) pays with the personal workspace, never with
     「the oldest workspace」.
6. **Leaving a workspace** ends your credentials' use there and nowhere else.
   Your bots in that workspace stop; what happens to them is open question 3.

The difference from ChatGPT and Claude is rule 3/4: they do not let a
personal Plus/Pro/Max plan pay inside a team workspace (§2.1). Alex asked
that your own account work in every workspace, so the proposal keeps that
and gives admins a switch instead. Option A in §4 is the strict copy.

## 2. Precedent

### 2.1 ChatGPT and Claude, the anchor

| | Claude | ChatGPT |
| --- | --- | --- |
| Account model | Personal and organization accounts on one email, switched in the lower-left menu ([9267400](https://support.claude.com/en/articles/9267400)) | One login, a personal workspace and Business workspaces, a profile-menu switcher ([8801890](https://help.openai.com/en/articles/8801890-can-i-migrate-or-merge-my-chatgpt-personal-workspace-over-to-my-chatgpt-business-workspace)) |
| Personal plan inside the team | Never applies. Moving a personal account into an org cancels a directly billed Pro/Max with a refund ([9267400](https://support.claude.com/en/articles/9267400)) | Never applies; the team seat counts. Whether Plus is cancelled on joining is unverified (one [forum report](https://community.openai.com/t/business-upgrade-from-plus-made-personal-workspace-disappear-and-codex-usage-feels-much-worse/1384454)) |
| Coding agent | Claude Code uses whichever account is logged in. Team seats include it. Admins can pin the org with `forceLoginOrgUUID`, which refuses a personal Max login ([authentication](https://code.claude.com/docs/en/authentication.md), [11845131](https://support.claude.com/en/articles/11845131)) | Codex uses the active workspace's plan and credits ([pricing](https://learn.chatgpt.com/docs/pricing.md), [admin setup](https://learn.chatgpt.com/docs/enterprise/admin-setup)) |
| Connectors / apps | The org enables a connector; each person authenticates and Claude acts with their permissions. Owners can limit actions org-wide ([11176164](https://support.claude.com/en/articles/11176164)) | The admin enables an app; each user authenticates. Admins can stop a corporate account being linked from a personal workspace ([12628342](https://help.openai.com/articles/12628342), [11487775](https://help.openai.com/en/articles/11487775)) |
| Projects / GPTs | Private by default, shareable inside the org ([9519189](https://support.anthropic.com/en/articles/9519189-project-visibility-and-sharing)) | When a member is removed, their GPTs and projects go to an owner and their chats are not handed over ([8266418](https://help.openai.com/articles/8266418)) |
| Memory | Per account. Enterprise owners can turn it off; Team members manage their own ([11817273](https://support.anthropic.com/en/articles/11817273-how-does-claude-s-memory-work)) | Per workspace. Owners can turn it off for the workspace ([9295112](https://help.openai.com/en/articles/9295112-memory-faq-business-version)) |
| Custom instructions | Per account ([10185728](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features)) | Per workspace, not migrated (secondary source only) |
| API keys | A separate Console org and workspaces with their own keys and spend limits ([workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces)) | A separate platform org and projects (official page unreachable) |

help.openai.com refused direct fetches, so the ChatGPT wording comes from
official pages as quoted in search results.

### 2.2 Other products

- **Linear:** the workspace installs GitHub and Slack. Each member connects
  their own GitHub account so actions are credited to them. Agents are
  workspace installs, not seats ([github](https://linear.app/docs/github),
  [agents](https://linear.app/docs/agents-in-linear)).
- **Slack:** admins approve or restrict apps; members install approved ones
  ([App approval](https://slack.com/help/articles/222386767-App-approval)).
- **Notion:** Custom Agents have an owner and page-like sharing, stop 7 days
  after losing their owner, and spend the owner's credits unless an admin
  funds them from workspace credits
  ([sharing](https://www.notion.com/help/custom-agents-sharing-and-permissions),
  [credits](https://www.notion.com/help/how-ai-credits-work-for-custom-agents)).
- **GitHub:**
  - A PAT belongs to the user, but the org can require approval before it
    touches org resources
    ([policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)).
  - Under SSO, a token is authorized per org, and that authorization ends
    when the user is removed
    ([SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on)).
- **Cursor:** admins enforce Privacy Mode and team rules. Model limits and
  turning off users' own API keys are Enterprise-only. A user's own key is
  billed by the provider. There is a team spend limit, and Enterprise adds
  per-member limits
  ([enterprise](https://cursor.com/docs/account/teams/enterprise-settings),
  [keys](https://cursor.com/help/models-and-usage/api-keys),
  [limits](https://cursor.com/docs/account/billing/spend-limits)).
- **Vercel:** tokens are created on the personal account and scoped to the
  full account, a team or a project. Git login connections are personal
  ([tokens](https://vercel.com/docs/accounts/access-tokens),
  [git](https://vercel.com/docs/git)).
- **Devin:**
  - The org owns the machine snapshot, repo access and the ACU (Agent Compute
    Unit) cap
    ([orgs](https://docs.devin.ai/enterprise/getting-started/organizations)).
  - Secrets come in org, personal, repo and session scopes; personal secrets
    are hidden even from admins
    ([secrets](https://docs.devin.ai/product-guides/secrets)).
- **LobeHub:** personal and workspace budgets draw on separate credits. The
  evidence is thin ([glossary](https://lobehub.com/de/docs/glossary)).

### 2.3 What they share

1. Credentials belong to the person, and resources and invoices belong to the
   workspace.
2. Integrations exist twice: the workspace enables them and each person
   authenticates.
3. Admins govern personal items with allowlists, approval, enforced settings,
   ceilings and identity pinning, but never own or see the credential.
4. Agents made in a workspace are workspace resources with an owner. When the
   owner leaves they are reassigned (ChatGPT) or wait for a new owner
   (Notion).
5. The context a run belongs to pays, except for the person's own key.
6. Notifications are always personal.

## 3. Mikka today

### 3.1 Settings pages

Sources: `lib/settings-sections.ts:27-49`, `components/settings/settings-view.tsx:102-121`.

- **个人:** 账户, 安全, 偏好设置, 通知, 记忆与建议, 连接, 模型与额度,
  登录与密钥, 数据与隐私, 设备, 个人访问令牌 (hidden).
- **工作区:** 常规, 成员, 团队, Bot 与 Agents, 团队权限, 密钥与环境,
  审计日志, 用量, 计费.

### 3.2 Item by item

The page column shows where the item is set. Data and run-time columns give
the key used.

| Item | Page | Data (key) | Run time (key) | Mismatch |
| --- | --- | --- | --- | --- |
| Profile, sign-in, sessions | 个人 | `user`, `session`, `account` (user) | user | — |
| Theme, language | 个人 | browser, `attention_settings` (user) | user | — |
| Issue prefix | 个人 › 偏好设置 | `issue_prefixes` (user) | user | Issues live in workspaces; minor |
| Notifications | 个人 | `user_preferences.push*`, `mobile_push_tokens` (user) | user | — |
| Memory, suggestions, personal instructions | 个人 | `user_preferences`, `user_facts` (user) | Model cost goes to `executionWorkspace(userId, null)`, the **oldest** workspace (`lib/profile/extract.ts:35`) | **Yes:** an implicit payer |
| Apps (Composio), GitHub, Linear, Telegram | 个人 › 连接 | `composio_accounts`, `github_repository_installations`, `linear_connections`, `telegram_links` (user) | user, gated by `workspace_app_policies` (workspace) | — (the rule above) |
| Skills, personal MCP | 个人 › 连接 | `personal_skills`, `personal_mcp_servers` (user) | user | — |
| Saved logins | 个人 › 登录与密钥 | `credentials` (user) | user | — |
| Devices, daemon | 个人 › 设备 | `devices`, `agents` (user); `device_tokens.boundWorkspaceId` optional | user, any workspace (`lib/rule-dispatch.ts:24-27`) | — |
| **Model subscriptions** (Claude, Codex) | **个人** › 模型与额度 | `byos_connections`, `byos_bindings` and the related `byos_*` tables (**owner + workspace**) | bot owner + the bot's workspace (`lib/execution-settings.ts:433-591`); the Go worker and secret bundle check `WorkspaceID` | **Yes:** the page is personal but the data is per workspace, so the account is invisible in other workspaces; leaving the workspace kills it. This contradicts decision 2026-10-31 「every bot replies」 (「A connected subscription belongs to the account」). |
| Bot model choice | 工作区 › Bot 与 Agents | `bot_model_choices` PK (owner, workspace, botKey) | same | **Yes:** see 3.3 |
| Task defaults, label rules | 工作区 › Bot 与 Agents | `execution_rules` (owner + workspace) | same (`lib/rule-dispatch.ts:17-22`) | Personal data on a 工作区 page; acceptable as 「my rules in this workspace」 |
| 设备离线时 / Bot 额度用完时 | 工作区 › Bot 与 Agents | `"user"."executionFallbacks"` (**user**) | owner | **Yes:** shown as workspace, stored as account |
| Bots | bot list | `bots` (owner + workspace) | owner only (`app/actions/bots.ts:36-40`) | — (already 「a person's bot in a workspace」) |
| New-bot defaults | 工作区 › 常规 | `workspace_settings.defaultModel/defaultRepository` (workspace) | copied at creation | — |
| Cloud computer | bot › 电脑 | `cloud_machines` PK (workspace, owner); `bot_desktops` | workspace + owner; allowed by `workspace_computer_policies` | — |
| E2B key, secrets | 工作区 › 密钥与环境 | `workspace_e2b_keys`, `workspace_secrets` (workspace) | workspace | — |
| App and computer policy, model admission | 工作区 › 团队权限 | `workspace_app_policies`, `workspace_computer_policies` (workspace) | workspace | — |
| Hosted model, points, billing | 工作区 › 用量 / 计费 | `hosted_*`, `workspace_billing`, `workspace_credit_grants` (workspace) | `hostedModel(workspaceId, …)`. The Coordinator and background jobs bill the **oldest** workspace (`lib/execution-settings.ts:595-634`) | **Yes:** an implicit payer |
| Members, teams, general, danger zone, audit | 工作区 | `mikka_workspace_*`, `mikka_teams`, `workspace_audit_*` (workspace) | workspace | — |
| Personal access tokens | hidden | `personal_access_tokens` (user + workspace) | pinned to one workspace | — (Vercel-style scoping) |

### 3.3 Why Bot 与 Agents showed 「未连接账号」

The P0 fix is in another session and this document does not touch it.

1. **The rows come from an empty source.** The page lists `byos_bindings`
   rows with route `codex_cpa`/`claude_cpa` for (viewer, workspace).
   - Connecting in 模型与额度 inserts only `byos_connections`.
   - `refreshBotModels` (`lib/execution-settings.ts:470-498`), the only writer
     of these bindings, has no caller in the UI.
   - The e2e spec inserts bindings directly
     (`tests/e2e/bot-agents-settings.spec.ts:26-31`), which hid the gap.
2. **The two pages can resolve different workspaces.**
   - `BotAgentsSettings` gets no `workspaceId` (`settings-view.tsx:119`), and
     its reads ignore `?workspace=` (`app/api/settings/[read]/route.ts:41-45`).
     The server then picks the cookie or the oldest membership.
   - 模型与额度 uses the explicit `?workspace=`.

The rule in §1 removes the second cause by construction: once a subscription
is account-level, it no longer depends on which workspace a page resolved.

### 3.4 No personal workspace in the schema

- `mikka_workspaces` has no kind column (`lib/db/workspace-schema.ts:4-12`).
- A default workspace is created lazily, only when the user has **no
  memberships at all** (`lib/workspace-access.ts:58-71`). Its id is derived
  from `orvilo-default:<userId>`.
- A person whose first workspace came from an invite therefore never gets a
  personal one.
- A default workspace may since have gained members, and nothing tells it
  apart from a team.

## 4. Options for 「不管你在哪个工作区，你都可以用自己账号」

| | A. Strict copy (ChatGPT/Claude) | B. Personal subscription usable in teams the admin allows (recommended) |
| --- | --- | --- |
| Rule | A subscription lives in one workspace; a team runs only on its own connections, Mikka 默认 or an E2B key | A subscription is account-level and runs the owner's bots in any workspace whose admin has not switched off 个人订阅 |
| Matches Alex's wish | No: connect again in each workspace | Yes |
| Tenant isolation | Trivial | Still holds: a credential only runs its owner's bots (rule 3), and the run's workspace context goes only to the owner's own provider account. The admin switch covers teams that must keep code out of personal accounts, like Claude Code's `forceLoginOrgUUID`. |
| Billing | Unchanged | The owner's plan quota pays for subscription runs, and the workspace pays only for Mikka 默认 and Mikka Cloud. 用量 shows subscription runs as 0 points. |
| Data change | Keep `workspaceId`; add the policy switch only | See §6 |

## 5. Target scope per item

| Item | Today | Target | Move? |
| --- | --- | --- | --- |
| Profile, sign-in, preferences, language, notifications | account | account | — |
| Memory, suggestions, personal instructions | account | account; background model cost to the personal workspace | payer only |
| Apps, GitHub, Linear, Telegram, skills, personal MCP | account | account; per-workspace admin allowlist (exists) | — |
| Saved logins | account | account | — |
| Devices, daemon | account | account; per-workspace computer policy (exists) | — |
| **Model subscriptions** (`byos_connections`, CPA bindings) | owner + workspace | **account**; per-workspace switch 个人订阅 (default on) | **yes** |
| Bot model choice (`bot_model_choices`) | owner + workspace + bot | unchanged; a bot already belongs to one workspace | — |
| 设备离线时 / Bot 额度用完时 | account, shown under 工作区 | account, shown in 个人 › 模型与额度 | UI only |
| Task defaults, label rules | owner + workspace | unchanged; the page title says 「我的」 rules in this workspace (open question 5) | — |
| Bots | owner + workspace | unchanged: a person's bot inside a workspace; personal bots live in the personal workspace | — |
| Coordinator | per workspace (choice row), billed to the oldest workspace | open question 4 | ? |
| Cloud computer, E2B key, secrets, policies, hosted points, billing, members, teams, audit | workspace | workspace | — |
| Personal workspace | implicit, sometimes missing | explicit `kind`, one per person, single member | **yes** |

## 6. Minimal migration

Scope is option B. Option A needs only step 3.

1. **Mark personal workspaces.**
   - Add `mikka_workspaces.kind text not null default 'team'`, checked to be
     `personal` or `team`.
   - Backfill `personal` on each user's default-hash workspace that still has
     exactly one active member.
   - A default workspace that has gained members stays `team`; that user, and
     every user without a personal workspace, gets one lazily in
     `loadWorkspaceContext`. Change the check from 「no memberships」 to 「no
     own personal workspace」.
   - New personal workspaces take no invites. 邀请成员 there offers to create
     a team workspace instead.
2. **Make subscriptions account-level.**
   - Keep `byos_*."workspaceId"` as written: it records where the connection
     was made and stays in the secret bundle's integrity check
     (`packages/subscription-worker/bundle.go:125,215`), so no bundle is
     re-published and nobody reconnects.
   - Drop it from the **lookup** predicates. Connections and CPA bindings are
     found by `ownerId`; the run's workspace comes from the bot
     (`executionWorkspace` already reads `bots.workspaceId`). The places are
     `lib/execution-settings.ts:434-591`, `lib/subscription-http.ts:96-126`,
     `lib/computer/bot-subscription.ts:19-29`, `lib/computer/queue-run.ts:25-37`
     and the Go reads in `runtime_use.go`.
   - Make deterministic binding ids hash `ownerId` + connection + route
     without the workspace (`execution-settings.ts:489,543-546`). Existing
     rows stay valid; new ones dedupe by `ON CONFLICT`.
   - Keep `bot_model_choices` as it is.
   - Duplicate connections (the same provider account connected in two
     workspaces) stay as separate rows. The list shows each account once,
     keyed by `providerSubject`, and nothing is deleted.
3. **Add the workspace policy.** Add `workspace_computer_policies.personal_subscriptions
   boolean not null default true`, as one switch in 团队权限. When it is off,
   runs in that workspace refuse with 订阅不可用 and the existing next steps;
   they do not fall back to a paid default, which matches the frozen-subscription
   rule.
4. **Set an explicit payer.** `executionWorkspace(userId, null)` returns the
   personal workspace instead of the oldest membership.
5. **Move one row in the UI.** 设备离线时 / Bot 额度用完时 move from
   Bot 与 Agents to 个人 › 模型与额度; the data stays put.

There are no foreign keys or unique constraints on `byos_*.workspaceId`, so
the schema part is one column and one boolean; the work is in the queries.

## 7. Conflicts with earlier decisions

- 2026-10-31 「Every bot replies」 says a subscription belongs to the
  account. The data is per workspace, so the code is behind the decision, not
  the other way round. The proposal implements the decision.
- 2026-10-30 「$1 allowance to the first workspace using that card」 and
  「E2B only on the workspace's key」 are unchanged.
- No earlier decision makes subscriptions workspace-owned.

## 8. Open questions for Alex

1. **A or B?** Recommended: B, with the admin switch on by default.
2. **Is the personal workspace single-member, like ChatGPT's?** Recommended:
   yes; inviting someone creates a team workspace.
3. **When a member leaves**, are their bots in that team archived, or handed
   to an admin like ChatGPT's GPTs? Threads stay with the workspace either
   way.
4. **Coordinator:** one per person, living in the personal workspace and
   seeing every workspace's events, or one per workspace? The glossary calls
   it 「each person's proactive personal agent」, which points to one per
   person.
5. **Memory:** keep it account-level (Claude) or split it per workspace
   (ChatGPT)? Recommended: account-level, with a per-workspace admin off
   switch later if a team asks.
