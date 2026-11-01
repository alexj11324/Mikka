# Browser permissions have no "ask"

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「为什么会有询问这个选项？询问这个选项应该出现在这里吗？」, answering no, under his 2026-10-30 decision that bots operate their browsers without asking
- Rule: —
- Replaces: —; completes the 2026-10-30 decision (bots operate their browsers without asking)

A browser action's permission is allow or deny. The Decisions judgment that
the action serves the person's task is the gate; no browser effect waits for a
human approval card. Settings and the API reject `browser_<effect>: ask`, and
the migration `20261101190000_browser_ask_retired.sql` turned every stored
one, on agent heads and workspace policies, into allow. Deny on either layer,
and a workspace computer deny, still block.
