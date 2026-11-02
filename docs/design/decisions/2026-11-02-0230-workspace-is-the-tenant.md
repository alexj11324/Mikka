# The workspace is the tenant

- Date: 2026-11-02
- Source: Relayed by the coordinating Claude session on 2026-11-02 as Alex's requirement; not yet confirmed by Alex in the repo. It generalises the settings split Alex gave in 2026-11-02-0216 (PR #895, not yet on main): 「个人工作区和团队工作区的区别只在『人与人之间』的东西（成员、团队、团队权限、审计日志、共享额度、离开成员的 Bot、转让）。凡是工作区自身的能力，两边都要有。」
- Rule: R-26
- Replaces, in part, once Alex confirms: [2026-11-01-2310](2026-11-01-2310-personal-and-team-workspaces-apart.md) levels 2 and 3 where they list 密钥与环境 and Bot 与 Agents as team settings (2026-11-02-0203 in PR #890 and 2026-11-02-0216 in PR #895 already replace those lines for settings); [`orchestration.md`](../orchestration.md) § 1 "Team workspace … secrets"

A workspace is the tenant. A personal workspace is a tenant with one member;
a team workspace is a tenant with several. Both have every capability of a
workspace. Only what exists between people is team-only. The account is not a
tenant: what is bound to the person (sign-in, devices, connections, model
credentials, profile memory) follows them into every workspace and is stored
once, per account.

Rules, cited by id in [information-architecture.md](../information-architecture.md):

- **T1** One tenant per workspace. Every bot, chat, task, thread, Artifact,
  secret, credit and invoice belongs to exactly one workspace.
- **T2** Team-only means "between people": members and invitations, teams,
  roles and 团队权限, member audit (审计日志), shared credits, card
  designation and seats, 分享给团队成员, bots of people who left, and transfer
  of the workspace.
- **T3** Data isolation stops at the workspace. Nothing moves between two
  workspaces, personal or team (R-26).
- **T4** Billing ownership stops at the workspace. The workspace where the
  work happens pays ([2225](2026-10-31-2225-bindings-belong-to-the-person.md) rule 1).
- **T5** Secret scope stops at the workspace. A secret is injected only into
  runs of its own workspace, or of one repository in it.
- **T6** The account is outside every tenant. An account-level object enters
  a tenant only through an explicit share in that tenant (分享给团队成员,
  我的点数也可用于这个团队), and the share leaves with the member.

## Considered options

- **Personal workspace as a reduced tenant** (decision 2310, level 2): hides
  secrets and bot settings. Rejected: a single person's runs need secrets and
  bot defaults as much as a team's; that is what 0203 and 0216 corrected.
- **No personal workspace; the account is the tenant** (Vercel's Hobby
  account, GitHub's user account). Rejected: decision 2130 already gives
  every person a personal workspace, and one tenant shape for both kinds keeps
  one code path for bots, threads, secrets and billing.

## Generic multi-tenancy checklist applied

From the Kubernetes multi-tenancy skill (`arjunprabhulal_devops-skills`),
only its generic items; namespaces, NetworkPolicy, node isolation and API
fairness have no counterpart here and are skipped.

| Checklist item | Here |
| --- | --- |
| Pick soft or hard tenancy and state the trust assumption | Soft between members of one workspace (they trust each other within its policies); hard between workspaces (no data, secret or credit crosses, T3–T5) |
| One unit of ownership | The workspace (T1) |
| A quota per tenant before its first workload | The free allowance on a new workspace; credit caps per workspace and per bot (`workspace_settings`, `bots.monthlyCreditLimit`) |
| Roles scoped to one tenant, no cross-tenant role | 管理员 / 成员 per workspace; an admin never sees or uses a member's account-level credential ([2240](2026-11-01-2240-own-credentials-always-usable.md)) |
| Shared platform services need explicit allow rules | Account-level objects enter a tenant only by an explicit share (T6) |
| Noisy neighbours | Per-bot and per-workspace credit caps; runs are charged where they happen (T4) |

## Consequences

- 设置: 常规 (without 转让; a personal workspace cannot be deleted), Bot 与
  Agents, 密钥与环境, 用量 and 计费 show in both kinds; 成员, 团队, 团队权限,
  审计日志, 付款, 分享给团队成员 and 已暂停的 Bot only in a team workspace.
  PRs #890 and #895 do this in code.
- `glossary.md` (Workspaces table, team row), `orchestration.md` § 1 and
  `docs/settings.md` drop 密钥与环境 from the team-only lists once Alex
  confirms.
- Deleting a workspace deletes every row keyed by it, its secrets included
  (T5); today `deleteAppData` leaves several behind (see the
  information-architecture gap list).
- Deleting an account treats the person's bots in a shared workspace as
  leaving does: paused for an admin to take over, not deleted (T2: bots of
  people who left are a team's).
- A per-person object stored per workspace is either a share (T6) or a
  per-workspace preference of that person (Bot 与 Agents rules); anything
  else is moved to the account.
- The server refuses team-only operations in a personal workspace, not only
  the UI: invitations already do (`workspacePersonal`); creating a team does
  not yet.
