# Web and desktop clients

Mikka ships two clients over one UI:

- **Web** — the Next.js app in this repository, in a browser.
- **Desktop** — an Electron shell that loads the same UI and injects
  `window.mikka` (`packages/protocol/src/bridge.ts`).

The shell owns native abilities; the UI asks for them through capabilities
(`packages/protocol/src/platform.ts`, `lib/platform/`). It never infers the
platform from the user agent or from a query parameter.

## Capability matrix

| Capability | Web | Desktop |
| --- | --- | --- |
| Local daemon identity (`device.localIdentity`) | no | yes, from the daemon on this computer |
| System notifications (`notifications.system`) | no | yes |
| Dock/taskbar badge (`notifications.badge`) | no | yes |
| Native folder picker (`device.pickRepo`) | no | planned |
| Quota snapshot from the local daemon (`quota.snapshot`) | no | yes |
| Stable preview scheme (`preview.scheme`) | no | planned |
| Local settings storage (`settings.local`) | no | no, the shell reuses the web session today |

A capability is on only when the bridge method behind it exists, so a shell can
ship a smaller surface without the UI claiming a feature it cannot perform.

## Rules

- The server always renders the web snapshot. A desktop renderer switches to
  the desktop snapshot after hydration; do not branch before mount.
- Settings are one surface shared by both clients (`docs/settings.md`, Figma
  `503:7105`): devices live in Settings › 设备, not on a standalone page. The
  desktop shell does not add a second settings surface.
- `本机` follows R-23 and is a product grouping, not a platform signal: it
  describes directly connected machines, on the web and on the desktop alike.
- The desktop renderer keeps the Dock badge at the number of runs waiting for
  the person and raises a system notification when a run enters 等你 or fails.
  Clicking the notification opens that issue. The first snapshot after launch
  is a baseline, so opening the app never replays old notifications.
- The desktop shell reuses the web session in its window. Keychain storage,
  short-lived JWTs, device linking and saved tabs are later phases; the bridge
  declares their methods only when they exist. Updates use `electron-updater`
  against published GitHub Releases; draft releases are not offered.
- On macOS the desktop window is translucent, as in Codex: the window uses the
  `sidebar` vibrancy material (`apps/desktop/src/main/window-appearance.ts`), and
  the preload sets `data-desktop-translucent` on `<html>`. Under that attribute
  the frame chrome (window bar, rail) and the card's first column (bot list,
  settings list) paint no background of their own, so the material shows
  untinted; the content column and right panels stay opaque. Hover and current
  fills there (`--sidebar-accent`, `--sidebar-item`) become a black (light) or
  white (dark) overlay, and ghost buttons and the settings search field take
  `--control` instead of the opaque `muted`.
  `tests/e2e/desktop-translucent.spec.ts` checks this over a solid page color.
  Reduce transparency, Windows and Linux keep the opaque window. The setting is
  read at launch.
- Feature flags (PostHog) gate rollout; capabilities gate possibility. Compose
  them with `&&`, never substitute one for the other.
