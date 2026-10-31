# Bindings belong to the person; the workspace where work happens pays

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator:
  「所有的绑定（绑卡、绑订阅）默认都放给个人…首先是绑到个人，然后再分享到工作区，而不是由管理员统一来设置」
  and 「个人离开这个团队工作区以后…他个人的这个订阅就从团队工作区里面消失，团队工作区就不能用他个人的订阅了」;
  on letting other members use a shared subscription, 「B」; on cloud
  snapshots, 「对你的建议没有错，应该这样去做」
- Rule: —
- Replaces: in [personal vs workspace](2026-10-31-2130-personal-vs-workspace.md),
  the three admin switches, 「a subscription runs in any workspace the owner
  belongs to」, and 「work with no workspace of its own bills the personal
  workspace」. Its personal workspace, `kind`, settings nav and moved
  settings stand.

1. **The workspace where the work happens pays.** Every run, triage, memory
   extraction and cloud machine belongs to one workspace and is charged
   there. Nothing moves to the new personal workspace. **Interim:** work with
   no bot of its own (the Coordinator's triage, memory extraction) bills the
   person's earliest active membership, as before. Verification is per person
   (rule 6), so it cannot silently stall. This is replaced when events carry
   their `workspaceId`, in the per-workspace memory follow-up (§8.5).
2. **Bindings belong to the account.** Cards and Claude/ChatGPT
   subscriptions are bound to the person. Their personal workspace uses them
   automatically.
3. **Sharing a subscription into a team is the member's own choice,** per
   workspace: 模型与额度 › 在这里使用我的订阅. A shared subscription runs that
   member's own bots and runs. Admins do not configure bindings; they have
   one switch in 团队权限, 「允许成员使用个人订阅」, on by default. Off, every
   bot there replies on Mikka 默认; a run frozen on a subscription stops
   instead of falling back. App connections and devices already run only
   their owner's bots and get no further switch for now.
4. **The owner may also let other members' bots use it** (分享给团队成员,
   off by default; Alex, 「B」). Comma pools subscriptions per workspace the
   same way. Personal Claude and ChatGPT plans may not allow sharing with
   other people (see Precedent), so the risk sits with the subscription's
   owner: turning it on shows that warning and asks them to confirm.
   - A bot uses its owner's own subscription first; otherwise one another
     member shared here with 分享给团队成员, Claude first, then the oldest
     share; otherwise Mikka 默认. A Coordinator only ever uses its own
     person's subscription.
   - Other members see only 「X 的 Claude 订阅」 as available, never the
     credential; the owner sees, under 使用中, which bots used it.
   - Un-sharing, turning the option off, leaving, or the admin switch stops
     it for everyone at the next model call; a frozen run stops, no fallback.
5. **A member may pay for a team with their own card**
   (「由我的卡支付这个团队」). Follow-up: it changes who Stripe charges.
6. **Leaving a team, or un-sharing,** removes the member's subscription share
   (and card designation) from that workspace at once. Their bots there are
   paused (`bots.archivedAt`) until an admin takes one over (Bot 与 Agents ›
   已暂停的 Bot); a taken-over bot runs on the admin's own resources. If the
   removed card paid for the team, its admins are told and get a grace
   period (follow-up with rule 4).
7. **Verification is per person.** Once is enough: a new personal workspace
   counts as verified when its owner verified any workspace they own, and
   starts like a new sign-up, with the free allowance. The payment method
   stays per workspace (rules 2 and 5).
8. **Cloud snapshots hold software only, never credentials.** A workspace or
   thread snapshot contains the repository, its dependencies and the
   installed harnesses (Claude Code, Codex). The credential the resolver
   picked is injected at run start through the run-scoped broker, scoped to
   that run and gone when it ends or pauses, so un-sharing or leaving takes
   effect on the next run without a snapshot rebuild. Subscription tokens
   already never reach the sandbox (only a placeholder does); making
   snapshots exclude every other run credential is a follow-up.
9. **Migration.** A workspace with other members becomes `team` and keeps its
   history, bots, card, credits and billing. Every existing subscription
   stays shared where it was connected. Nothing silently stops.

## Precedent

- **ChatGPT Business bills per workspace; the owner pays,** and a personal
  plan stays separate from it. "Workspace owners can view and manage
  workspace billing information"; the workspace wallet "is separate from
  personal wallet balances"
  ([8792536](https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business)).
  "Joining Business does not automatically migrate your content or cancel
  your personal subscription"
  ([8801890](https://help.openai.com/en/articles/8801890)).
- **Personal accounts may not be shared.** OpenAI: "You may not share your
  account credentials or make your account available to anyone else"
  ([terms](https://openai.com/policies/row-terms-of-use/)). Anthropic: "You
  also may not make your Account available to anyone else"
  ([consumer terms](https://www.anthropic.com/legal/consumer-terms)). Hence
  rules 3 and 4: own use by default, and the owner's explicit, warned
  opt-in before anyone else's bot may use it.
- **Verification is a person's,** even where it unlocks an organization:
  OpenAI API organization verification uses one person's ID, and a person
  "can verify only one account or organization"
  ([10910291](https://help.openai.com/en/articles/10910291-api-organization-verification)).
- **Linear bills per workspace and admins manage payment.** "Customers are
  billed for the number of unsuspended users within a workspace";
  "Workspace admins can change or cancel a subscription"
  ([billing](https://linear.app/docs/billing-and-plans)). Credentials stay a
  person's: "Admins and permitted Members can create personal API keys", and
  "Admins can choose whether or not Members can create their own API keys"
  ([API](https://linear.app/docs/api-and-webhooks)), the model for one admin
  switch over members' own subscriptions.

help.openai.com refused direct fetches; its quotes come from the official
pages as shown in search results.
