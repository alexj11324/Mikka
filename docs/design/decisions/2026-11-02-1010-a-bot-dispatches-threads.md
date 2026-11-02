# A bot dispatches threads; an Agent runs them

- Date: 2026-11-02
- Source: Alex, relayed by the coordinating session: 「Bot 不做线程。线程由 Agent（Claude Code、Codex）来跑，Bot 只负责派出。」
- Rule: glossary (Thread, Words to avoid), R-50
- Replaces: glossary's 「Every thread belongs to exactly one bot」

A thread is run by an Agent (Claude Code, Codex). A bot never runs, owns or
does a thread; it only dispatches it. Every thread still names the one bot
that dispatched it.

Copy says so: 「<Bot> 派出的线程」 or 「<Bot> 派出」, as an open thread's
byline 「Coordinator 派出线程」 already does; never 「<Bot> 的线程」 or
「所属 Bot」. English: "threads a bot dispatched", never "a bot's threads".
`scripts/check-i18n.mjs` fails `messages/` copy that says 「所属 Bot」 or puts
「的线程」 straight after a bot.
