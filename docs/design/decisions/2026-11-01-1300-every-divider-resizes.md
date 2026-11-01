# Every vertical line between columns resizes them

- Date: 2026-11-01
- Source: Alex, on the line between 建议 and its Coordinator chat that would not drag: 「这里的 resizable 怎么又没有做？按照道理来说，只要是这种竖线都可以 resizable」; relayed by the coordinator, who added that a fix found page by page is not enough
- Rule: R-79 (new)
- Replaces: —

Any vertical line between two columns, on any page, can be dragged to resize
them. Before this only the bot list and the right panel could, because each
column chose on its own whether to use `hooks/use-resizable-width.ts`; every
other two-column page drew a fixed width and a border, so a new page could
not be resized by default.

- One implementation: `components/ui/resizable-pane.tsx`. `ResizablePane` is
  a column with a handle on the edge it shares with its neighbour;
  `ResizeHandle` is that handle alone, for columns that animate their own
  width (the right panel, the group panel, the bot list) or must not remount
  (a task's right panel). Both run on `useResizableWidth`.
- The handle: drag, arrow keys (Shift ×4, Home and End for the limits),
  double-click for the default, `col-resize` on hover, a minimum and a
  maximum, the width remembered per place on this device. A column whose
  default is a share (建议 is half and half) keeps it until the line is moved.
- Places: bot list, right panel and group panel (one remembered width), 建议,
  Artifact's list, the board's Coordinator sidebar, a task's right panel (an
  open thread and the properties each remember their own), the editor's
  outline and comments panel, a project's details, the settings list, the
  browser.
- Kept so: `scripts/split-pane-policy.mjs` (run by `pnpm lint`) fails any
  column in `app/` or `components/` that draws its own side border and keeps
  a fixed width without a handle. A line that is not between columns says why
  with a `split-pane-exempt: <reason>` comment. The browser test
  `tests/e2e/side-panel-resize.spec.ts` walks the rail pages at 1000px and
  drags every vertical divider it finds.
