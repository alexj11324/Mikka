# iOS: native first

- Date: 2026-11-05
- Source: Alex, relayed by the coordinator on #1386: "wherever iOS has a native control or behavior, use it. Only build our own when nothing native exists."
- Rule: —
- Replaces: —

In the iOS app, a control or behavior the system already has is the system's: menus are UIMenu (`Stack.Toolbar.Menu`,
`@expo/ui` `Menu`/`ContextMenu`), sheets are `formSheet`/`pageSheet` with detents, the navigation bar is the native
stack header with the system material, scrolling keeps the system's bounce and momentum, segmented controls, switches
and the activity indicator are the system's. We build our own only where iOS has none, and the reason is written next to
it in `docs/design/mobile.md` § Native first. The vendored beui kit (`components/beui/`) stays in the repository but is
not used for anything iOS provides. Our own motion follows one spring family (`apps/mobile/lib/springs.ts`).
