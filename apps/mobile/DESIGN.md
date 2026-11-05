# Mikka iOS: who draws what

This file covers how the app is built: which library owns each part of the screen, and how a change is checked.
What a screen looks like and says is still decided by `docs/design/` (README, `rules.md`, `mobile.md`, the decision
records), and those files win where this one disagrees. The architecture follows #1408
(decision `2026-11-05-1535-ios-openbot-architecture`).

## Owners

| Part of the screen | Owner | Notes |
| --- | --- | --- |
| Stacks, titles, back, bar buttons, header search | Expo Router native `Stack`, `Stack.Toolbar`, `Stack.SearchBar` | No hand-drawn header. A screen fills the system bar; it never draws one. |
| Route-level sheets (message actions, attach, forms) | A `formSheet` route with detents and the grabber | Not a JS bottom sheet. |
| App frame | `AppDrawer` (`features/shell/components/app-drawer.tsx`): one `Stack` on a surface over a push drawer | No tab bar (decision `2026-11-05-2005-ios-push-drawer`). The chat list is home (`app/index.tsx`). |
| Menus, pickers, switches, segmented controls, grouped settings forms | `@expo/ui` inside `Host` | `Stack.Toolbar.Menu` for a bar's menu. A settings switch row is SwiftUI's `Toggle` (`components/SettingsSwitch.ios.tsx`); sections are HeroUI `ListGroup` (`Group`). |
| Product content: buttons, cards, chips, fields, alerts, text | HeroUI Native and its `Typography` | Themed by `styles/tokens.css`. |
| AI-specific pieces HeroUI has no part for (tool approval, streamed text) | `components/beui/` | Same palette. A general control is HeroUI's, never a new beUI use. |
| Chat message text | React Native `Text` with the chat text styles | The one exception to `Typography`: chat text has its own sizes so it lines up with the composer. |
| Chat list | `@legendapp/list` (`KeyboardAwareLegendList`) | Virtualized, keeps the visible message in place when older ones load. |
| Floating controls over content (composer, jump to latest) | `expo-glass-effect` `GlassView` | See Glass. |
| Icons | SF Symbols through `@expo/ui` (`components/Symbol.ios.tsx`), lucide on web | |

## Colours

There is one palette. `lib/tokens.ts` holds the values. `lib/theme.ts` turns them into system colours for `style`
props, and `styles/tokens.css` gives the same values to Uniwind classes, HeroUI Native and beUI, in light and dark.
`tests/theme-tokens.test.mts` fails when a CSS value differs from the token named in its comment. To change a colour,
edit both files.

The layers follow iOS's grouped screens:

| Layer | Class | Light / dark |
| --- | --- | --- |
| Page | `bg-background` | grouped, `#F2F2F7` / black. The chat page stays `colors.page`, white / black |
| Card, sheet row | `bg-surface` | `#FFFFFF` / `#1C1C1E` |
| Muted fill, secondary button, default alert, chip | `bg-default` | chip grey, `#EBEBF0` / systemFill. It shows on a card and on the white chat page |
| Outline | `border-border`, transparent fill | separator |

A secondary button is filled and has no outline.

## Text

- Chat body: 16 pt on a 22 pt line, the same as the composer. Secondary chat text: 14 on 20.
- A reference to a thread or task is tinted inline text with a 12 pt icon. It never changes the height of its line.
- Everything outside the chat uses `Typography` or the system's own controls.

## Glass

- Use glass only for controls that float over content: the composer and the jump-to-latest button.
- Bars and tab bars get their glass from the system.
- Without Liquid Glass, or with Reduce Transparency on, the control is a solid lifted surface.
- `useLiquidGlass()` (`lib/glass.ts`) says whether to draw glass: iOS 26 with Reduce Transparency off. Every glass control uses it.
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
- Every horizontal drag in a vertical list is axis-locked. It starts only after a clear sideways movement and gives way
  to scrolling on a vertical one:
  - The bubble swipe to quote starts after about 16 pt sideways and fails after about 12 pt vertical.
  - The left swipe for message times starts after 10 pt sideways, when that is 1.5× the vertical movement.
- The push drawer opens by a drag to the right on the home screen, or from the home bar's workspace button.
  - The drag starts after 12 pt to the right and gives way to 10 pt up or down.
  - It uses a 300 ms spring with damping 0.8 and no overshoot.
  - It settles open when the drag, carried a fifth of a second on, is past halfway (`features/shell/model/drawer.ts`).
  - A tap on the dimmed app or a drag back closes it.
- On the home list (decision `2026-11-05-2010-ios-home-list-interactions`):
  - A swipe left shows 置顶 at 88 pt and pins past 144 pt.
  - Holding 250 ms and then moving drags a chat; a move before the hold scrolls or swipes.
  - A long press is the system context menu over the chat's preview (`Link.Menu`, `Link.Preview`).
- Holding a bubble for 500 ms opens its actions. After about 120 ms the bubble starts to shrink to 0.96 scale, so the
  hold reads as pressed.

## Size

- Icons in a row of actions are 14–18 pt.
- Every touch target is at least 40 pt, through `hitSlop` where the drawn control is smaller.

## Source layout

- `app/` holds routes only. A chat route re-exports its screen from `features/`.
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
- Before adding a dependency, compare the fingerprint with and without it:

```sh
cd apps/mobile && npx fingerprint fingerprint:generate --platform ios
```

## Checking a change

Expo Web screenshots check layout, colour and copy. They do not check:

- UIKit navigation, sheets and menus
- Liquid Glass
- haptics
- gestures against scrolling
- the keyboard
- VoiceOver
- Dynamic Type
- Reduce Motion

Every iOS UI PR therefore carries:

- Expo Web screenshots at 375, 393 and 430 pt, in light and dark;
- a TestFlight checklist for Alex to work through after the OTA. Each line names one thing to do and what he should
  see; put bubble layout and scrolling first whenever the chat changes;
- a kill switch for a risky native change, such as `NATIVE_MESSAGE_MENU`.
