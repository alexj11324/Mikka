# The icon rail shows icons only; names are tooltips

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator: 「把这个地方的文字去掉，hover 上去才显示」 (first decided in #580, recorded in `../decisions.md` under "2026-10-31 — Icon rail without labels")
- Rule: R-35
- Replaces: the label-under-icon rail that #747 brought back; the "72px icon rail with labels" phrase of the 2026-10-25 row in `../decisions.md`

The rail's items (主页, 建议, 看板, 插件, Artifact) are icon buttons with no
visible text. Each name shows as a tooltip on hover, to the right, and stays
the button's accessible name. The rail is 68px wide again. #747 put the labels
back because R-35 still said "72px icon rail with a text label under each
icon"; R-35 now says icons only, and `tests/e2e/rail-tooltips.spec.ts` fails
if a label renders again.
