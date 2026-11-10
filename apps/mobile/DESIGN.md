# Mikka iOS: who draws what

This file covers how the app is built: which library owns each part of the screen, and how a change is checked.
What a screen looks like and says is still decided by `docs/design/` (README, `rules.md`, `mobile.md`, the decision
records), and those files win where this one disagrees. The architecture follows #1408
(decision `2026-11-05-1535-ios-openbot-architecture`).

For every iOS UI change, load the vendored
[`swiftui-expert-skill`](../../.claude/skills/swiftui-expert-skill/SKILL.md)
and the matching Expo skills through
[`expo-overview`](../../.claude/skills/expo-overview/SKILL.md).
The [skill registry](../../.claude/skills/README.md) defines their scopes.
SwiftUI guidance governs native iOS behavior and appearance, including
`@expo/ui/swift-ui` trees and native modules. Expo guidance determines the
Expo/React Native mechanism. Mikka's accepted decisions determine product
behavior. This ownership guide describes source structure and development
requirements. Device acceptance is recorded separately.

## Owners

Use the existing components for each part of the screen.

| Part of the screen | Owner | Notes |
| --- | --- | --- |
| Stacks, titles, back, bar buttons, header search | `components/NavBar.tsx` configures Expo Router native `Stack`, `Stack.Toolbar`, and native search options | iOS uses the system navigation bar. The web screenshot build uses the shared React Native header. Tab roots have one centred title and right-side controls, per decision `2026-11-08-0120-ios-header-like-comma`. |
| Route-level sheets (message actions, attach, forms) | A `formSheet` route with detents and the grabber | Not a JS bottom sheet. |
| App frame | `NativeTabs` (`app/(tabs)/_layout.tsx`) with Bot · 任务 · 建议 · 设置 and a search tab | Decision `2026-11-07-2045-tasks-only-threads-inside` replaces the thread tab. The Bot list opens at `app/(tabs)/(chats)/index.tsx`. Chats, task details, and task conversations push over the tabs. |
| Menus, pickers, switches, segmented controls, grouped settings forms | `@expo/ui` inside `Host` | `Stack.Toolbar.Menu` for a bar's menu. |
| Product content, cards, fields, and text | Existing shared components in `components/`, with HeroUI Native where used | Reuse `components/ui.tsx`, `cards.tsx`, and `Text.tsx` as the surrounding screen does. HeroUI Native uses `styles/tokens.css`. |
| AI-specific pieces HeroUI has no part for (tool approval, streamed text) | `components/beui/` | Same palette. A general control is HeroUI's, never a new beUI use. |
| Chat message text | React Native `Text` with the chat text styles | `components/chat.tsx` owns bubble typography. |
| Chat list | `@legendapp/list` (`KeyboardAwareLegendList`) | Virtualized, keeps the visible message in place when older ones load. |
| Floating controls over content (composer, jump to latest) | `expo-glass-effect` `GlassView` | See Glass. |
| Icons | SF Symbols through `@expo/ui` (`components/Symbol.ios.tsx`), lucide on web | |

## Colours

There is one palette. `lib/tokens.ts` holds the values. `lib/theme.ts` turns them into system colours for `style`
props, and `styles/tokens.css` gives the same values to Uniwind classes, HeroUI Native and beUI, in light and dark.
`tests/theme-tokens.test.mts` fails when a CSS value differs from the token named in its comment. To change a colour,
edit both files.

The layers use the shared tokens and iOS system colours.

| Layer | Class | Light / dark |
| --- | --- | --- |
| Page | `bg-background` | grouped, `#F2F2F7` / black. Screens using `colors.page`, including Bot and chat, are white / black |
| Card, sheet row | `bg-surface` | `#FFFFFF` / `#1C1C1E` |
| Muted fill, secondary button, default alert, chip | `bg-default` | chip grey, `#EBEBF0` / systemFill. It shows on a card and on the white chat page |
| Outline | `border-border`, transparent fill | separator |

A secondary button is filled and has no outline.

## Text

- Chat body in `components/chat.tsx` uses 16 pt on a 25 pt line. The composer's input uses 16 on 22. Quoted message text uses 14 on 20.
- A reference to a thread or task is tinted inline text with a 12 pt icon. It never changes the height of its line.
- Shared text uses `components/Text.tsx`, the existing library component, or the system control used by its screen.

## Glass

- Use glass for controls that float over content, including the composer, jump-to-latest button, and header buttons.
- iOS toolbar buttons and the tab bar get their glass from the system. Navigation bars stay transparent with no material or hairline, per decision `2026-11-08-0120-ios-header-like-comma`.
- Without Liquid Glass, or with Reduce Transparency on, the control is a solid lifted surface.
- `useLiquidGlass()` (`lib/glass.ts`) gates custom glass surfaces on availability and Reduce Transparency. Native toolbars and tabs use the system's own handling.
- Never imitate glass with blur.
- To hide a glass control, animate its effect style to `none`. Animating opacity doesn't work: glass stops drawing
  under a fully transparent parent.

## Motion and gestures

- Springs come from `lib/springs.ts`.
- With Reduce Motion on, a view jumps to its end state instead of animating.
- Chat scrolling follows the v0 model:
  - The chat opens at the latest message.
  - A sent message rises to the top of the chat, and blank space waits under it.
  - The reply fills that space without auto-scrolling.
  - A glass down arrow returns to the latest message.
- Chat messages use native text selection on long press. Reactions, 回复, 复制 and 选择文本 live in ⋯ under bot replies
  and other members' messages. A centred time separates message groups after a 15-minute gap or a new day.
  See [the chat interaction decision](../../docs/design/decisions/2026-11-08-1430-ios-chat-gestures-and-header.md).
- On the home list (decision `2026-11-05-2010-ios-home-list-interactions`, with its 2026-11-07 supersession):
  - A swipe left shows the capsules 置顶 and 隐藏 at 148 pt and pins past 230 pt.
  - Chats and pinned tiles have no drag reordering. Unpinned chats sort newest first. The pin grid still reads stored pin order in `features/home/model/home-list.ts`.
  - A long press is the system context menu over the chat's preview (`Link.Menu`, `Link.Preview`).
- Holding a bubble for 500 ms starts native text selection. After about 120 ms the bubble starts to shrink to 0.96 scale,
  so the hold reads as pressed. Letting go or scrolling springs it back. The screen's left edge uses the system back gesture.

## Size

- Icons in a row of actions are 14–18 pt.
- Every touch target is at least 40 pt, through `hitSlop` where the drawn control is smaller.

## Source layout

- `app/` holds file-based routes. Migrated feature routes, including chat and task detail, re-export their screens from `features/`.
- `features/<feature>/` holds `components/`, `model/` (hooks and pure logic) and `screens/`.
  - The chat feature keeps the header, the message list and the composer in separate files.
- `shared/` holds code that more than one feature uses.
- `lib/` and `components/` stay as they are until each piece moves into a feature. Never delete a component library
  folder (`components/beui/`, AGENTS.md).

## Not used

- Patches to native libraries.
- `expo-blur` and HeroUI's blur variants.
- Custom fonts: the app uses the system fonts.
- JS bottom sheets, dialogs, popovers and toasts. HeroUI's toast is turned off in `app/_layout.tsx`.

## Native builds and OTA

- `runtimeVersion` follows the native fingerprint, so an OTA update only reaches builds with the same fingerprint.
- Adding a package with native code, a config plugin or a native setting needs a new TestFlight build.
- JS-only packages and styles ship by OTA.
- Before adding a dependency, compare the fingerprint with and without it in cloud Linux.

```sh
cd apps/mobile && npx fingerprint fingerprint:generate --platform ios
```

## Verify a change

Expo Web screenshots check layout, colour and copy. Check these native behaviors on TestFlight.

- UIKit navigation, sheets and menus
- Liquid Glass
- haptics
- gestures against scrolling
- the keyboard
- VoiceOver
- Dynamic Type
- Reduce Motion

Every iOS UI PR carries the following evidence.

- Expo Web screenshots at 375, 393 and 430 pt, in light and dark.
- a TestFlight checklist for Alex to work through after the OTA. Each line names one thing to do and what he should
  see. Put bubble layout and scrolling first whenever the chat changes.
- a kill switch for a risky native change, such as `NATIVE_MESSAGE_MENU`.
