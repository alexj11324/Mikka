# An explicit browser "ask" the person set is followed

- Date: 2026-11-01
- Source: the coordinator session, relaying Alex's rule that a choice the person set by hand is followed (the same as for pull request creation): 「用户自己设置了 browser ask，就必须按 ask 处理，不能当成 allow。」
- Rule: —
- Replaces: narrows the 2026-10-30 decision (bots operate their browsers without asking): a stored `browser_<effect>: ask` is no longer read as allow

By default a Bot's browser actions still run after the Decisions judgment
that they serve the person's task, with no approval card. When the person or a
workspace admin set `browser_<effect>` to `ask`, that action waits on their
approval card (the existing pending `browser_operation` path) instead of
running. Deny on either layer still blocks, and wins over ask.
