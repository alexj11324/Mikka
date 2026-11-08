# 全部线程's button counts the threads waiting on you

- Date: 2026-11-02
- Source: Alex, in this session, on the Figma draft 802:56 (「待 Alex 确认 · 全部线程等你计数」): 「可以呢，做吧」
- Rule: R-82
- Superseded in part by: [2026-11-07-2045](2026-11-07-2045-tasks-only-threads-inside.md) (the window-bar entry lists tasks) and [2026-11-07-2300](2026-11-07-2300-one-conversation-per-task.md) (its hand count includes only tasks needing the person, excluding blocked tasks).
- Replaces: —

1. **The count is the 等待你 group.** The window bar's 全部线程 button (and the
   phone header's) shows how many rows of 全部线程 sit in 等待你 (R-52: waiting
   for input, a question for you, a PR to review, an ended thread not judged
   yet), counted as the list groups them, so the badge and the list's
   「等待你（N）」 always agree.
2. **How it looks.** A Badge · warning-light after the threads icon, led by
   等待你's raised hand (#891); past 99 it reads 99+. With nothing waiting the
   button is the icon alone.
3. **What it says.** The tooltip and the accessible name are 「全部线程，N 条等你」.
   The button stays pressed while the list is open, and the count stays.
