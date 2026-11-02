# The personal workspace comes first; a one-person team needs no sharing

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session after a screenshot of the account menu (「青柠科技」「acme的工作区」「创建团队工作区」, with no way to tell the personal one apart and no way to pick a workspace in 设置): 「用户注册后第一个必须是个人工作区。没有个人工作区就不能创建团队工作区。」 and 「团队工作区只有一个人时，所有东西默认都能用（点数、订阅、API Key、电脑……），不需要再点『给团队用』之类的开关。只有在多个人、要把东西共享给别人时，才需要权限设置。」 Open questions answered provisionally by the coordinator, pending Alex: a second member joining leaves the credit switch off; the 设置 workspace picker changes only the workspace being configured.
- Rule: R-26
- Replaces, in part: [2026-10-31-2130-personal-vs-workspace](2026-10-31-2130-personal-vs-workspace.md) (the personal workspace was created on first need, after an invitation if that came first); [2026-11-01-2310-personal-and-team-workspaces-apart](2026-11-01-2310-personal-and-team-workspaces-apart.md) level 3 (「我的点数用于这个团队」 shown in every team); [2026-11-02-0231-workspace-is-the-tenant](2026-11-02-0231-workspace-is-the-tenant.md) T6 (an account-level object enters a tenant only through an explicit share; a one-person team is the exception)

1. **Personal first.** Signing up creates the person's personal workspace.
   Creating a team workspace and accepting an invitation make sure it exists
   first, on the server, so nobody has a team without one. Loading any
   workspace page still creates it if it is missing (accounts from before
   this decision).
2. **A one-person team shares nothing.** While a team workspace has one
   active member (pending invitations and suspended members do not count),
   everything that person owns is usable there without a switch: credits,
   subscriptions, API keys, computers, the E2B key. Subscriptions, API keys,
   computers and the E2B key already were
   ([2240](2026-11-01-2240-own-credentials-always-usable.md)); credits now
   are too: the team's own balance pays first, then the member's personal
   credits. The sharing switches (分享给团队成员, 我的点数也可用于这个团队)
   are not shown while there is nobody to share with.
3. **A second member brings the switches back.** From then on the switches
   and permissions decide, as before; the credit switch starts off, so the
   first member's personal credits stop paying for the team until they turn
   it on. Each hosted call re-checks, so the change takes effect on the next
   call.
4. **One predicate.** `workspaceSoloMember` in `lib/workspace-solo.ts`
   answers "one person here?" for every such decision, including the Mikka
   default-credit check.
5. **Telling them apart.** The account menu marks the personal workspace
   「个人」; 设置 lets the person pick which workspace to configure (Figma
   page 「待 Alex 确认 · 个人与团队工作区」).
