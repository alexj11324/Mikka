# 已完成 keeps its 300px beside the Coordinator sidebar

- Date: 2026-11-01
- Source: Alex, production screenshot of the board with the Coordinator sidebar
  open (`/en?section=all-issues`), the 40px 「Done」 strip next to the sidebar
  circled as a bug; relayed by the coordinator: 「看板列永远保持固定宽度，宽度不够时整个看板横向滚动」.
- Rule: R-25
- Replaces: the `decisions.md` row of 2026-10-31 on board columns, only its
  sentence that 已完成 collapses to a 40px strip while the sidebar is open.

Every board column is a fixed 300px whether or not the Coordinator sidebar is
open. When the columns do not fit, the board scrolls horizontally; no column
folds or shrinks. Beside the sidebar the hidden-columns lane is still left out
(hidden columns stay reachable from 显示). The rest of that row (card spec,
300px columns, horizontal scroll) stands.
