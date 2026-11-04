# Preserve browsing state when returning

- Date: 2026-11-03
- Source: Alex, bug report with screenshots: 「我们原本在最底下的『已解决』里，点进去之后再退出来，又会恢复成最顶上的那个状态」; follow-up: 「我发现很多地方都会直接复原……把所有的这些问题都查一遍，然后把该修复的就修复好」.
- Rule: R-52, R-82 (existing list grouping and navigation behavior)
- Replaces: —

Returning from a thread restores the list's scroll position, search and expanded
resolved group. Returning to a Bot, group chat, task, project, Artifact category,
plugin store or board restores its own browsing state and unsent text where
applicable. Back, forward, closing a detail and switching panels use the same
state cells.

Browsing state belongs to the signed-in account and workspace, then to the
particular object and view. Keep it in the window's session, including reloads;
keep existing device preferences (pane widths and board display settings) in
their existing persistent stores. An explicit search clear or group collapse
updates the remembered value. Dialogs and pending server operations retain
their existing lifecycle.

This fixes behavior without changing layout, copy or the default collapsed
resolved group on a first visit. See the audit and verification record.
