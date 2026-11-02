# One person is a personal workspace; a team starts with a second person

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session after a screenshot of the account menu (「青柠科技」「acme的工作区」「创建团队工作区」, with no way to tell the personal one apart and no way to pick a workspace in 设置): 「用户注册后第一个必须是个人工作区。没有个人工作区就不能创建团队工作区。」 Then, correcting the first draft: 「个人是没有团队的概念的，个人工作区就是个人工作区。1. 一个人是没有团队的，必须是个人工作区。2. 如果要新建团队工作区，必须邀请第二个人参加才叫团队。如果没有邀请第二个人，是不能建立团队工作区的。」 On a member joining a team: 「默认不付」. On where sharing is set: 「他在添加订阅的时候，添加完之后，下面就应该显示一个『是否共享给团队』，而不应该在团队那上面进行操作……明明应该在同一个页面显示的地方，你跑到另外一个页面，导致我找不到，又用不了。」 Alex left the 设置 workspace picker open; the coordinator chose the option below.
- Rule: R-26
- Replaces, in part: [2026-11-01-2310-personal-and-team-workspaces-apart](2026-11-01-2310-personal-and-team-workspaces-apart.md) level 3 (「我的点数用于这个团队」 shown in every team) and [2026-11-02-0216-personal-workspace-has-workspace-settings](2026-11-02-0216-personal-workspace-has-workspace-settings.md) (「分享我的订阅给团队成员」 and 「我的点数用于这个团队」 set in a team workspace's settings); [2026-10-31-2130-personal-vs-workspace](2026-10-31-2130-personal-vs-workspace.md) (the personal workspace was created on first need, after an invitation if that came first, and a team could be created alone)

1. **One person is a personal workspace.** Signing up creates it; it is the
   person's first workspace. Creating a team workspace and accepting an
   invitation make sure it exists first, on the server. Loading any
   workspace page still creates it if it is missing (accounts from before
   this decision). There is no "team of one".
2. **A team starts with a second person.** Creating a team workspace takes a
   name and at least one invitation to someone else; without one it cannot
   be created, in the form and on the server. The creator's own address
   does not count.
3. **Sharing is set next to the resource.** 「共享给团队」 is set where the
   person adds and manages the thing: on each subscription and API key row in
   模型与订阅 (and right after adding one), and for personal credits in the
   person's own 计费 as 「也用于这些团队」, where each team also has
   「我的卡」 (由我的卡支付这个团队; one member's card per team, so another
   member's card shows as 「<名字>的卡在付」). A team's settings show who
   shares what, read-only; they are not where it is set. The switches show
   only for teams the person is in. Each is off when the person joins or
   creates a team: their credits do not pay for it until they turn that on.
   A team admin's ban on sharing (团队权限 › 订阅与 API Key) holds for
   subscriptions and API keys alike: the switch is disabled and names the
   admin who turned sharing off; when the viewer is that admin, it links to
   the setting instead.
4. **Fallback when a team is left with one member.** A team can still end up
   with one active member: a team from before this decision, or the others
   left or were removed. Until someone else joins, that member's own credits
   pay for it without the switch (subscriptions, API keys, computers and the
   E2B key already work for their owner everywhere, decision
   [2240](2026-11-01-2240-own-credentials-always-usable.md)). This is a
   safety net, not a kind of workspace: nothing in the product names it.
   `workspaceSoloMember` in `lib/workspace-solo.ts` is the one check for it,
   used by billing (`lib/credit-shares.ts`) and the Mikka default model.
   Pending invitations and suspended members do not count as members. What
   the product shows such a team (for example, a prompt to invite someone)
   is open.
5. **Telling them apart.** The account menu lists the personal workspace
   first and marks it 「个人」. 设置 lets the person pick which workspace to
   configure, without changing the workspace they are working in.
