# Threads carry their Agent's mark, never a bot's

- Date: 2026-11-01
- Source: Alex, relayed by the coordinating session: 「BOT 是不干活的，至少是不干 coding 活的。这个 coding 活是要交给 harness 去做的，Agent 去做的」
- Rule: adds R-78; changes R-50 (全部线程 row icon) and R-62 (who runs a thread); glossary
- Replaces: R-50's 16px bot avatar on 全部线程 rows, and R-62's 「The bot runs the thread … never as the runner」

A thread or run is executed by an Agent (Claude Code, Codex…), not by the
bot that dispatched it. Wherever a thread or run is drawn with an icon, the
icon is that Agent's mark (`HarnessMark`); a thread whose Agent is unknown
takes the neutral thread mark, never a bot or Coordinator avatar. The bot
appears only where it dispatched or owns the work. Lists that show a thread's
status keep the status icon. Board cards' assignee avatars are assignees,
not threads, and are unchanged.

Applied in the web 全部线程 rows and the run citations in chat (inline chip
and sources list). The phone's thread list and thread cards already use status
icons and show no bot avatar.
