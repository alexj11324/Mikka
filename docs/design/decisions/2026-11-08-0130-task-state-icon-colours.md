# Task state icons carry their state's colour

- Date: 2026-11-08
- Source: Alex on TestFlight after OTA 8e208aa5: the task status icons were all grey; he wants them coloured the way LobeHub colours each status glyph. Relayed by the coordinator: 「状态图标有颜色：等你=蓝，受阻/运行=橙，失败=红，完成=绿，待办/取消=灰」.
- Rule: `apps/mobile/features/tasks/components/task-icons.tsx`; `docs/design/components.md` (Mobile task list)
- Superseded in part by: [2026-11-13-1405](2026-11-13-1405-one-task-status.md) (on the web a task's icon is its status field's, in R-34's colours; these colours remain for the Agent mark, run results and the iOS app).
- Replaces: 「Grey, never a coloured dot」 for the glyphs in 2026-11-07-2230 (the icon shapes stay; dots and badges stay out)

Each status glyph takes an iOS system colour, so it follows light, dark and
Increase Contrast by itself. Text, including the grey reason line, keeps its
colour.

| State | Glyph | Colour |
|---|---|---|
| 等你处理 / 等你回复 / 评审中 | hand, pause, gauge | systemBlue |
| 受阻 | octagon | systemOrange |
| 运行中 / 进行中 | ring | systemOrange |
| 排队中 / scheduled | clock | systemOrange |
| 失败 | triangle | systemRed |
| 完成 | check | systemGreen |
| 待办 ○ / 暂不处理 ◌ | circle, dashed circle | tertiaryLabel |
| 已取消 ✕ / 重复 ⊘ | x, slashed circle | secondaryLabel |

The same colours apply to the group-bar icons, the task detail's status chip,
the attempt icons in 活动 and the chat's task cards. Still no coloured dots or
badges.
