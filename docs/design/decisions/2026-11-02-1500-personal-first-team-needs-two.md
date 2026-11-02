# One person is a personal workspace; a team starts with a second person

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session after a screenshot of the account menu (「青柠科技」「acme的工作区」「创建团队工作区」, with no way to tell the personal one apart and no way to pick a workspace in 设置): 「用户注册后第一个必须是个人工作区。没有个人工作区就不能创建团队工作区。」 Then, correcting the first draft: 「个人是没有团队的概念的，个人工作区就是个人工作区。1. 一个人是没有团队的，必须是个人工作区。2. 如果要新建团队工作区，必须邀请第二个人参加才叫团队。如果没有邀请第二个人，是不能建立团队工作区的。」 Then: 「只要填了邮箱，那边邀请了就算团队，不需要检查。」 and 「比如你已经邀请了一个人，那个人还没有回复你，没有接受邀请。那么你也可以进入团队界面，上面就会显示是否共享给团队。」 On a member joining a team: 「默认不付」. On a team left with one person: 「走了就走了呗，只有你一个人，那就用你默认的点数呀。然后点数如果没了，用不了，你可以走 API 呀，还有订阅呀。」 On where sharing is set: 「他在添加订阅的时候，添加完之后，下面就应该显示一个『是否共享给团队』，而不应该在团队那上面进行操作……明明应该在同一个页面显示的地方，你跑到另外一个页面，导致我找不到，又用不了。」 Alex left the 设置 workspace picker open; the coordinator chose the option below.
- Rule: R-26
- Replaces, in part: [2026-11-01-2310-personal-and-team-workspaces-apart](2026-11-01-2310-personal-and-team-workspaces-apart.md) level 3 (「我的点数用于这个团队」 shown in every team) and [2026-11-02-0216-personal-workspace-has-workspace-settings](2026-11-02-0216-personal-workspace-has-workspace-settings.md) (「分享我的订阅给团队成员」 and 「我的点数用于这个团队」 set in a team workspace's settings); [2026-10-31-2130-personal-vs-workspace](2026-10-31-2130-personal-vs-workspace.md) (the personal workspace was created on first need, after an invitation if that came first, and a team could be created alone)

1. **One person is a personal workspace.** Signing up creates it; it is the
   person's first workspace. Creating a team workspace and accepting an
   invitation make sure it exists first, on the server. Loading any
   workspace page still creates it if it is missing (accounts from before
   this decision). There is no "team of one".
2. **A team starts with a second person.** Creating a team workspace takes a
   name and at least one invitation to someone else; without one it cannot
   be created, in the form and on the server. The server checks only that:
   at least one address, shaped like an email, not the creator's own. It
   does not check whether the address has an account, exists, or accepts.
   Once the invitations are sent, the team exists, whether or not anyone has
   accepted yet.
3. **Sharing is set next to the resource.** 「共享给团队」 is set where the
   person adds and manages the thing: on each subscription and API key row in
   模型与订阅 (and right after adding one), and for personal credits in the
   person's own 计费 as 「也用于这些团队」, where each team also has
   「我的卡」 (由我的卡支付这个团队; one member's card per team, so another
   member's card shows as 「<名字>的卡在付」). A team's settings show who
   shares what, read-only; they are not where it is set. The switches show
   for every team the person is in, including one whose invitations are not
   accepted yet. Each is off when the person joins or creates a team: their
   credits do not pay for it until they turn that on.
   A team admin's ban on sharing (团队权限 › 订阅与 API Key) holds for
   subscriptions and API keys alike: the switch is disabled and names the
   admin who turned sharing off; when the viewer is that admin, it links to
   the setting instead.
4. **Fallback when a team is left with one person.** When everyone else has
   left or been removed and no invitation is waiting, the person left uses
   their own credits there without the switch; teams that already have one
   person (from before this decision) are treated the same, with no data
   moved. The team stays a team; it shows a way to invite someone.
   Subscriptions, API keys, computers and the E2B key already work for their
   owner everywhere (decision
   [2240](2026-11-01-2240-own-credentials-always-usable.md)). This is a
   safety net, not a kind of workspace: nothing in the product names it,
   and it does not decide whether the sharing switches show.
   `workspaceSoloMember` in `lib/workspace-solo.ts` is the one check for it,
   used by billing (`lib/credit-shares.ts`) and the Mikka default model. A
   pending, unexpired invitation counts as someone; a suspended member does
   not. Running out of credits is not a dead end: the run moves on to the
   person's own API keys and subscriptions in 允许使用的模型 order.
5. **Telling them apart.** The account menu lists the personal workspace
   first and marks it 「个人」. 设置 lets the person pick which workspace to
   configure, without changing the workspace they are working in.
