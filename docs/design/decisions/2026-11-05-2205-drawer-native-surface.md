# The open drawer uses system surfaces, not a flat grey slab

- Date: 2026-11-05
- Source: Alex, on his iPhone, about the drawer in #1455: 「这块这颜色之类都不像是原生的呀」. The open surface read as a hard grey rectangle, and the drawer as a flat white panel.
- Rule: —
- Replaces: the material of the dim and the drawer fill in [2026-11-05-2005](2026-11-05-2005-ios-push-drawer.md). The geometry (width, radius at least 34 pt, spring, gestures) stays.

- The drawer is `secondarySystemBackground`: grouped grey in light, one step above the black page in dark. Its places are one inset group on `tertiarySystemBackground`, rows 44 pt, the same step a settings card takes above a grouped page. Text is `label` and `secondaryLabel`. Icons are `secondaryLabel`. Separators are `separator`.
- The open app stays `systemBackground`. It scales to 0.96 so the corner radius sits inside the screen, and takes a soft shadow (`drawerLift`). The veil is `drawerDim` (6% black in light, 18% in dark), not the modal `scrim` (35% / 60%). The page's own colour, and what is on it, stay visible.
- No blur and no new native module. The system colours are `PlatformColor`. The veil is a `DynamicColorIOS` because iOS has no colour for it.
- The workspace row starts 12 pt below the safe area.
