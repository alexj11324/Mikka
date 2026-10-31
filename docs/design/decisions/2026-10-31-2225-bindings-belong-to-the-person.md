# Bindings belong to the person; the workspace where work happens pays

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator:
  「所有的绑定（绑卡、绑订阅）默认都放给个人…首先是绑到个人，然后再分享到工作区，而不是由管理员统一来设置」
  and 「个人离开这个团队工作区以后…他个人的这个订阅就从团队工作区里面消失，团队工作区就不能用他个人的订阅了」
- Rule: —
- Replaces: in [personal vs workspace](2026-10-31-2130-personal-vs-workspace.md),
  the three admin switches, 「a subscription runs in any workspace the owner
  belongs to」, and 「work with no workspace of its own bills the personal
  workspace」. Its personal workspace, `kind`, settings nav and moved
  settings stand.

1. **The workspace where the work happens pays.** Every run, triage, memory
   extraction and cloud machine belongs to one workspace and is charged
   there. Work with no bot of its own (the Coordinator's triage, memory
   extraction) keeps billing the workspace it billed before, until events
   carry their workspace (with per-workspace memory, §8.5). Nothing moves to
   the new personal workspace.
2. **Bindings belong to the account.** Cards and Claude/ChatGPT
   subscriptions are bound to the person. Their personal workspace uses them
   automatically.
3. **Sharing a subscription into a team is the member's own choice,** per
   workspace: 模型与额度 › 在这里使用我的订阅. A shared subscription runs only
   that member's own bots and runs, never another member's: personal Claude
   and ChatGPT plans may not be shared with other people. Admins do not
   configure bindings; they have one switch in 团队权限,
   「允许成员使用个人订阅」, on by default. Off, every bot there replies on
   Mikka 默认; a run frozen on a subscription stops instead of falling back.
   App connections and devices already run only their owner's bots and get
   no further switch for now.
4. **A member may pay for a team with their own card**
   (「由我的卡支付这个团队」). Follow-up: it changes who Stripe charges.
5. **Leaving a team, or un-sharing,** removes the member's subscription share
   (and card designation) from that workspace at once. Their bots there are
   paused (`bots.archivedAt`) until an admin takes one over (Bot 与 Agents ›
   已暂停的 Bot); a taken-over bot runs on the admin's own resources. If the
   removed card paid for the team, its admins are told and get a grace
   period (follow-up with rule 4).
6. **Verification is per person.** Once is enough: a new personal workspace
   counts as verified when its owner verified any workspace they own, and
   starts like a new sign-up, with the free allowance. The payment method
   stays per workspace (rules 2 and 4).
7. **Migration.** A workspace with other members becomes `team` and keeps its
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
  rule 3: a shared subscription only ever runs its owner's work.
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
