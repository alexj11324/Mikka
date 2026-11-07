# Web and desktop clients

Mikka ships two clients over one UI:

- **Web** — the Next.js app in this repository, in a browser.
- **Desktop** — Electron bundles the same React components, fonts and styles,
  serves them from `mikka://app/mikka`, and injects
  `window.mikka` (`packages/protocol/src/bridge.ts`).

The local renderer decision is recorded in
[`2026-11-05-1615-desktop-bundled-renderer.md`](decisions/2026-11-05-1615-desktop-bundled-renderer.md).
Web still renders through Next.js. Desktop sends validated operations through
main; neither the application session nor live-push tickets enter its renderer.

The shell owns native abilities; the UI asks for them through capabilities
(`packages/protocol/src/platform.ts`, `lib/platform/`). It never infers the
platform from the user agent or from a query parameter.

## Capability matrix

| Capability | Web | Desktop |
| --- | --- | --- |
| Local daemon identity (`device.localIdentity`) | no | yes, from the daemon on this computer |
| System notifications (`notifications.system`) | no | yes |
| Dock/taskbar badge (`notifications.badge`) | no | yes |
| Native folder picker (`device.pickRepo`) | no | yes, native dialog and Git repository validation |
| Quota snapshot from the local daemon (`quota.snapshot`) | no | yes |
| Stable preview scheme (`preview.scheme`) | no | planned |
| Local settings storage (`settings.local`) | no | no; application settings remain shared server data |

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
- The bundled desktop keeps its bearer session in main and encrypts persisted
  state with Electron's OS-backed `safeStorage`; unavailable or insecure storage
  fails closed. Google/GitHub authentication stays in the system browser and
  returns through the existing one-use PKCE loopback exchange. The renderer
  receives only the safe user summary and public session id. Saved tabs and
  general local settings remain deferred. Updates use `electron-updater`
  against published GitHub Releases; draft releases are not offered.
- The bundled desktop connects to Mikka Cloud or a self-hosted server (#1557,
  [decision](decisions/2026-11-06-2300-desktop-connects-to-self-hosted-servers.md)).
  Each stored account names its server; main sends an account's bearer only to
  that exact probed origin and base path, and the page's `app.serverUrl`,
  `openExternal` origin, sign-in handoff, live ticket request and the daemon
  installed on this computer follow the current account's server. The renderer
  never chooses an unprobed server.
- `MIKKA_DESKTOP_RENDERER=hosted` retains the previous web-session renderer for
  explicit rollback during #1415. `Mikka Dev` uses a separate profile and never
  checks or installs production desktop updates.
- On macOS the desktop window is translucent, as in Codex: the window uses the
  `sidebar` vibrancy material (`apps/desktop/src/main/window-appearance.ts`), and
  the preload sets `data-desktop-translucent` on `<html>`. Under that attribute
  the frame chrome (window bar, rail) and the settings list paint no
  background of their own, so the material shows untinted there. The bot list
  lays `--shell-material` over it instead, a grey
  veil (light 75 %, dark 82 % opaque): the rail stays clear and the list reads
  darker, apart from both the rail and the content, as in the ChatGPT desktop
  app. The content column and right panels stay opaque. Hover and current
  fills there (`--sidebar-accent`, `--sidebar-item`) become a black (light) or
  white (dark) overlay, and ghost buttons and the settings search field take
  `--control` instead of the opaque `muted`.
  `tests/e2e/desktop-translucent.spec.ts` checks this over a solid page color.
  Reduce transparency, Windows and Linux keep the opaque window. The setting is
  read at launch.
- Feature flags (PostHog) gate rollout; capabilities gate possibility. Compose
  them with `&&`, never substitute one for the other.
