# Overview and the browser are work-area tabs; no window bar on the web

- Date: 2026-11-09
- Source: Alex, in the session for #1847: the search bar, ✋ and 🌐 at the top can go because the shell already replaces them, and 概览 can be a tab.
- Rule: R-02, R-35, R-57 (hosted edition only).
- Replaces: in the hosted edition, the right-hand 概览 column beside a chat, and the window bar's search pill, waiting count (✋) and 浏览器 globe.

In the hosted edition a chat is affectUI's Agent / Thread. It has one right-hand area, its work area, and nothing else sits beside it.

- 概览 (details, tasks, PRs, computer) and 浏览器 are tabs in that work area. They stay folded until the person asks for one:
  - from the New tab's Tools;
  - with ⌘⇧B for 浏览器;
  - on the phone, from the chat's pill.
- The window bar is gone on the web. ← → stay in the desktop app.
  - Search stays in the shell's Search… ⌘K.
  - The waiting count moves to 收件箱 in the shell's navigation.
  - The 全部任务 button goes; 任务 in the navigation lists the same tasks. An old `?threads=` link lands on 任务, or stays on its open thread.

The open-source UI is unchanged: there `FRAME_OWNS_PANEL` and `FRAME_OWNS_HEADER` are false, and R-02, R-35 and R-57 apply as written. R-02's header content (the bot, then 详情 / 任务 / PR / 电脑) is kept inside the 概览 tab.
