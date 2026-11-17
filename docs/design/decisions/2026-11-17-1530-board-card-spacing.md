# 看板 cards keep their distance from the tray

- Date: 2026-11-17
- Source: Alex, 2026-11-17, on 看板 cards sitting against their column's edge with an empty line reserved under a short title: 「这个怎么靠边缘这么近」「肯定不能贴边搞呀」, and to follow other products and best practice.
- Exception to: [2026-11-09-0050](2026-11-09-0050-paid-blocks-as-shipped.md), for the affectUI Kanban's column and card spacing only. Its parts, glyphs and colours stay.

## Decision

As Linear, Jira and GitHub Projects lay out a column:

- 8px between a column tray's edge and its cards, and 8px between cards.
- 12px inside a card.
- A card is as tall as what it says. A task with no second line has none reserved; a title wraps to two lines before it is cut.

The rules live with the board slot in the hosted UI (`slots/board.tsx`).
