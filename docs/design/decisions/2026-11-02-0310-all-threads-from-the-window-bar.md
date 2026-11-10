# 全部线程 from the window bar; ← back in an open thread

- Date: 2026-11-02
- Source: Alex, relayed by the coordinating session: 「『全部线程』现在藏在某个 Bot 右侧面板的 tab 里……要看所有线程，得先点开一个 Bot，这不符合导航常识。……把『全部线程』提到最顶层：桌面端放在窗口顶栏右侧，即搜索框右边、地球图标旁边……手机网页端也要有同等入口。」 and 「标题最左边现在是一个一直在转的加载圈。……改成向左的箭头（←），作为返回键，点了回到线程列表……从哪来就回哪去。……键盘 Esc 或系统后退要和 ← 行为一致。」
- Rule: R-82
- Replaces: the 全部线程 tab in a bot's right panel (decisions/2026-11-01-1320-navigation-model.md's 「the right panel's 线程 and 全部线程」)
- Superseded by: [2026-11-07-2045-tasks-only-threads-inside.md](2026-11-07-2045-tasks-only-threads-inside.md) (the window-bar list is 全部任务; threads open only inside their task)

1. **全部线程 is a place of its own.** A button beside the globe in the window
   bar (on a phone, in the page header) opens it in the right column on any
   page, whichever bot is selected. It lists the threads every bot dispatched in R-52's
   groups; each row's second line opens with the mark of the Agent running it
   (R-78) and 「<Bot> 派出」, and 按派出者筛选 filters to the threads one bot
   dispatched (Alex, 2026-11-02: a bot dispatches a thread, an Agent runs
   it). Its address is `?threads=all` or
   `?threads=<bot>`; opening it is a new entry, the filter replaces it. It
   stays open as the centre changes.
2. **A bot's panel drops its 全部线程 tab.** Its 线程 tab lists the threads that bot dispatched.
   Two ways into the same list would break R-82's one place per object, and
   the panel's tab only existed beside a bot's chat.
3. **An open thread's header leads with ←.** ← goes back to the list it was
   opened from: 全部线程, a bot's 线程, the task's 线程 or the chat. Opening a
   thread is a history entry, so ← is the same step as the browser's back; Esc
   inside the thread does the same. A thread opened from a pasted link has no
   step to go back to, so its list replaces it. The spinning status icon left
   the header: the badge under it (运行中, 等待输入…) says the state. ✕ remains
   only where it closes more than ← (a thread over 全部线程 closes both).
