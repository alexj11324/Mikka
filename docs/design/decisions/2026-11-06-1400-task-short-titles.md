# Short titles for tasks and threads

- Date: 2026-11-06
- Source: Alex, relayed by the coordinator on 2026-11-06, after the research in
  [`docs/research/2026-11-06-agent-session-titles.md`](../../research/2026-11-06-agent-session-titles.md).
- Rule: —

- Lists name a task, and the threads that work on it, by a short title, the way Claude Code and Codex name a session:
  about 12 Chinese characters or 6 English words, with no issue key, date or time.
- Mikka writes it with its own small model (the Coordinator's flash model, through the app gateway and model admission),
  once, after the task is created. It is stored with the title it was written from, never written when a list is read.
  Claude Code's and Codex's own titles are not read.
- A person's or Linear's rename wins: the short title shows only while the task keeps the title it was written from.
- A failure or timeout writes nothing; the task keeps showing its own title, and creation never waits for the model.
- Existing tasks are not backfilled. The task editor keeps the full title.
