# One segmented control with a gliding pill; motion audit answers

- Date: 2026-10-31
- Source: Alex, 2026-10-31, comparing Claude Code's theme switcher: 「人家这个按钮点击是有 motion 的，我们为什么没有 motion 呢？就很生硬地一下子切过去…人家是做了个有点圆滑的矩形」 and 「你能查一遍吗？到底哪些地方应该加 motion 却没有加？」; audit answers relayed by the coordinator the same day
- Rule: R-31, R-33, R-37
- Replaces: `ToggleGroup variant="outline" spacing={0}` joined blocks with a straight inner edge and no motion; the shadcn tab list's per-trigger fill

**Segmented control.** One control everywhere, as in Claude Code: a `--control`
track with one inset pill (6px radius, rounded on every side, white in light)
that glides to the clicked option on `SPRING_LAYOUT` with no overshoot.

- Option groups are `ToggleGroup variant="segment"`: 界面主题, 语言, 推送,
  电脑操作, 审计筛选, 用量分组, 列表/看板.
- Tab lists are `TabsList`: the default variant is the same track and pill, and
  `line` slides its underline. 对话 \| 验收 and the team and project tabs use it.
- Both draw the mark with `SegmentIndicator` (`components/ui/segment-indicator.tsx`).
- With reduced motion the pill lands at once. Motion's root `MotionConfig`
  does not stop `layoutId` moves, so the indicator reads the setting itself.
- Nothing animates on first load or remount.

**Open:** the right panel's 概览 / 全部线程 and 详情 / 线程 / PR / 电脑 keep
their transparent pills (`TabsTrigger indicator={false}`) until Alex chooses
between them and this control.

**Motion audit answers:**

1. Board cards and thread rows animate in or out only on the person's own
   action; what others change appears without motion (R-37).
2. New chat messages fade in briefly, as in Claude Code.
3. A settings section switch, and a skeleton giving way to content, fade briefly.
4. The composer keeps growing line by line with no animation, as in Codex and
   Claude Code.
