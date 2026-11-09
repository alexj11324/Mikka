# Web and desktop clients

Mikka ships two clients over one UI:

- **Web** — the shared React renderer built with Vite, served by the
  Hono/Nitro application in `apps/api`, in a browser.
- **Desktop** — Electron bundles the same React components, fonts and styles,
  serves them from `mikka://app/mikka`, and injects
  `window.mikka` (`packages/protocol/src/bridge.ts`).

The local renderer decision is recorded in
[`2026-11-05-1615-desktop-bundled-renderer.md`](decisions/2026-11-05-1615-desktop-bundled-renderer.md).
The web entry is `apps/frontend/src/index.tsx`, which loads the shared
renderer in `apps/desktop/src/renderer/`. Desktop sends validated operations through
main; neither the application session nor live-push tickets enter its renderer.

The shell owns native abilities; the UI asks for them through capabilities
(`packages/protocol/src/platform.ts`, `lib/platform/`). It never infers the
platform from the user agent or from a query parameter.

## Capability matrix

| Capability | Web | Desktop |
| --- | --- | --- |
| Server selection (`server.select`) | no | yes, bundled renderer |
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

- The platform provider starts from the web snapshot. A desktop renderer
  selects the desktop snapshot after mount; do not infer native capability
  from the user agent.
- Settings are one surface shared by both clients (`docs/settings.md`, Figma
  `503:7105`): devices live in Settings › 设备, not on a standalone page. The
  desktop shell does not add a second settings surface.
- `本机` follows R-23 and is a product grouping, not a platform signal: it
  describes directly connected machines, on the web and on the desktop alike.
- The desktop renderer keeps the Dock badge at the number of runs waiting for
  the person. Transitions into 等你 or failure, and success when 线程完成 is on,
  are candidates for a Decisions API judgement before a system notification
  is shown. Clicking it opens the issue and its referenced run. The first snapshot after launch
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
  `tests/e2e/desktop-translucent.spec.ts` records the earlier browser check.
  Browser tests are retired from acceptance; use screenshots of the cloud
  Linux local production build and applicable native evidence.
  Reduce transparency, Windows and Linux keep the opaque window. The setting is
  read at launch.
- Feature flags (PostHog) gate rollout; capabilities gate possibility. Compose
  them with `&&`, never substitute one for the other.
