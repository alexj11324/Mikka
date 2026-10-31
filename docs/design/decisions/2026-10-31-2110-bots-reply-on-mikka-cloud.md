# Bots with no subscription reply on Mikka Cloud

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator session for the P0 「未连接账号」 report on 设置 › 工作区 › Bot 与 Agents (Coordinator, 「E2B acceptance 449729」, 「Oracle daemon 测试」): bots with no account can't reply, which takes usability to zero.
- Rule: —
- Replaces: the refusal for a saved choice whose account is gone (`binding_required`), added with group Bot members (c6207c9) and kept in #677.

With no Claude Code or Codex subscription bound, every Bot, the Coordinator
included, replies on Mikka Cloud: the hosted model and the workspace's credit,
through the usual admission and allowance. Its row in Bot 与 Agents shows
**Mikka Cloud**, never 「未连接账号」.

When a subscription is bound, the Bot uses it on its own: Claude first, then
ChatGPT/Codex (as decided for #537). A saved choice whose account was
disconnected or signed in again no longer counts as bound: the Bot moves to
another bound subscription, or to Mikka Cloud when there is none. It no longer
refuses to reply.
