# UI consistency audit (2026-10-31)

Hand-built controls where a shadcn (`components/ui/`), beUI
(`components/motion/`, `components/agents/`) or ReUI (`components/reui/`)
primitive exists, and the same control styled differently in different places.
Rules cited: R-30 (neutral greys), R-31 (secondary controls are `--control`
grey, no stroke), R-33 (radii: 6 tag, 8 button/input, 12 card, 14 list card,
16 dialog, 999 pill).

Reference sizes in this repo: Button `xs` h-6, `sm` h-7, `default` h-8,
`lg` h-9; Toggle `sm` h-7. `--radius` is 10px, so `rounded-md` = 8px,
`rounded-lg` = 10px, `rounded-sm` = 6px.

Out of scope here (owned by other branches): the settings members table
(`fix/members-table-gutter`), the kanban card (`fix/board-card-columns`),
scrollbars (`fix/coordinator-openui-scrollbar`), OpenUI charts
(`feat/openui-charts`).

## 看板 toolbar (`components/workspace/board-page.tsx`)

All three pieces Alex flagged are shadcn primitives, but each call site
overrides size and colour, so no two share a height, radius or grey:

| Piece | Primitive | Height | Radius | Grey |
| --- | --- | --- | --- | --- |
| 全部 / 工作区 / 个人 | shadcn `ToggleGroup`, wrapper overridden to `rounded-lg bg-muted p-0.5`, items `h-7 rounded-md` | 32px (28 + 2×2 padding) | 10px outside, 8px inside | `--muted` track, white pressed item |
| 筛选 | shadcn `Button variant="outline" size="sm"` | 28px | 8px | `--control` |
| 「负责人 \| 我 \| ×」 | shadcn `ButtonGroup` + two `ButtonGroupText` overridden to `h-6` + `Button size="icon-xs"` | 24px | 10px / 8px | `--control` ×3 with the 2px ButtonGroup gap, so it reads as three blocks |
| Board / list view switch | shadcn `ToggleGroup` default variant | 28px | 8px | transparent, `--muted` when pressed |

Fix (this PR): a `segment` variant on the shadcn `ToggleGroup` (track
`--control`, pressed item raised), used by both segmented controls; 筛选
stays `Button outline sm`; the filter chip is one `--control` container
holding the field, the value and a remove button. Every control on the bar is
28px high with an 8px outer radius on the `--control` grey.
