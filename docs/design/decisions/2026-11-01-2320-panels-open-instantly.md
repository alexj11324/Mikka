# Panels and columns open and close instantly

- Date: 2026-11-01
- Source: Alex, through the coordinator session, on opening a thread from
  「全部线程」 and closing it with ✕: 「你不应该在这个地方加 motion 吧」
  「这个叉号跟点击进入，应该加这个 transition motion 吗？」
- Rule: R-37 (changed)
- Replaces: R-37's "position and size move with springs" for panels and columns

Opening, closing and switching a panel or column happens at once: the right
column (概览, 全部线程, a group's panel), handing it to an open thread and
back, the bot list folding, the Artifact window, and the sheets that stand in
for these below `xl`. No slide, fade, zoom, width or height animation. What
stays is small state feedback: hover and press colours, a chevron turning on
a disclosure, loading indicators, and an error appearing.

Changed in code: `components/nav/context-panel.tsx`, `group-panel.tsx` and
`bot-list.tsx` (width spring), `components/workspace/issue-workspace.tsx`
(`AnimatePresence` around the panels), `components/artifacts/artifact-viewer.tsx`
(dialog fade and zoom), and the panel sheets in `issue-workspace.tsx` and
`components/ui/sidebar.tsx` (slide), through a new `instant` prop on
`DialogContent` and `SheetContent`. Other dialogs, menus and popovers keep
their library animation.
