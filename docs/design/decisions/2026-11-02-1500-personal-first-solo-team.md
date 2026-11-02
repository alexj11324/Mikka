# The personal workspace comes first; a one-person team needs no sharing

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session after a screenshot of the account menu (「青柠科技」「acme的工作区」「创建团队工作区」, with no way to tell the personal one apart and no way to pick a workspace in 设置): 「用户注册后第一个必须是个人工作区。没有个人工作区就不能创建团队工作区。」 and 「团队工作区只有一个人时，所有东西默认都能用（点数、订阅、API Key、电脑……），不需要再点『给团队用』之类的开关。只有在多个人、要把东西共享给别人时，才需要权限设置。」 Follow-ups the same day: a second member joining, 「默认不付」; and where the switch lives, 「他在添加订阅的时候，添加完之后，下面就应该显示一个『是否共享给团队』，而不应该在团队那上面进行操作……明明应该在同一个页面显示的地方，你跑到另外一个页面，导致我找不到，又用不了。」 Alex left the 设置 workspace picker open; the coordinator chose the option below (it changes only the workspace being configured).
- Rule: R-26
- Replaces, in part: [2026-11-01-2310-personal-and-team-workspaces-apart](2026-11-01-2310-personal-and-team-workspaces-apart.md) level 3 (「我的点数用于这个团队」 shown in every team) and [2026-11-02-0216-personal-workspace-has-workspace-settings](2026-11-02-0216-personal-workspace-has-workspace-settings.md) (「分享我的订阅给团队成员」 and 「我的点数用于这个团队」 set in a team workspace's settings); [2026-10-31-2130-personal-vs-workspace](2026-10-31-2130-personal-vs-workspace.md) (the personal workspace was created on first need, after an invitation if that came first); [2026-11-02-0231-workspace-is-the-tenant](2026-11-02-0231-workspace-is-the-tenant.md) T6 (an account-level object enters a tenant only through an explicit share; a one-person team is the exception)

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
4. **The switch sits next to the resource.** 「共享给团队」 is set where the
   person adds and manages the thing: on each subscription and API key row in
   模型与订阅 (and right after adding one), and for personal credits in the
   person's own 点数/计费 as 「也用于哪些团队」. A team's settings show at most
   who shares what, read-only; they are not where it is set. The switch shows
   only when the person belongs to a team with more than one member. A team
   admin's ban on sharing (团队权限 › 订阅与 API Key) still holds: the switch
   is disabled and says why.
5. **One predicate.** `workspaceSoloMember` in `lib/workspace-solo.ts`
   answers "one person here?" for every such decision, including the Mikka
   default-credit check.
6. **Telling them apart.** The account menu marks the personal workspace
   「个人」; 设置 lets the person pick which workspace to configure, without
   changing the workspace they are working in (Figma page
   「待 Alex 确认 · 个人与团队工作区」).
