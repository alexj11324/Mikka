# Bundled desktop renderer

This implementation reference tracks [#1415](https://github.com/alexj11324/Mikka/issues/1415) and the
[2026-11-05 decision](decisions/2026-11-05-1615-desktop-bundled-renderer.md).
`apps/desktop/src/main/index.ts` selects the bundled renderer by default.
`MIKKA_DESKTOP_RENDERER=hosted` selects the retained hosted path. The baseline
inventory and validation plan record the architecture change's original scope.

## Baseline inventory

Baseline: `ebd822e9c3b8af2b6dfb0967064438642761f59b` on `main`.

| Surface | Baseline |
| --- | --- |
| Localized pages | 21 `app/[locale]/**/page.tsx` files |
| Server actions | 212 exported async functions in 37 `app/actions/*.ts` files |
| Action consumers | 111 frontend files in the issue inventory; 101 TSX consumers (the remainder include hooks and TS helpers) |
| Shared UI | `components/`, `hooks/`, `app/globals.css`, `messages/` |
| Fonts | Inter Variable regular/italic and Geist Mono, bundled from `app/fonts/` |
| Native shell | `apps/desktop/src/main/`, preload and `@mikka/protocol` bridge |
| Live updates | `hooks/use-live-key.tsx`, `lib/live/`; preserve scoped invalidation |
| Hosted fallbacks | Existing Electron renderer and its browser/loopback sign-in |

The visible workspaces are rendered by `IssueWorkspace`; settings reuse
`SettingsShell` and the existing section components. Coordinator, bot and group
chats, details, threads, PRs, computers, Artifacts and task creation keep their
existing components. Legacy redirects, auth pages and link-entry pages remain
part of the route inventory rather than being silently dropped.

## Architecture

1. A separate browser bundle imports existing UI components. Build-time aliases
   replace Next-only routing, server-action imports and browser session access.
   Server implementation modules must not enter the browser dependency graph.
2. A local standard, secure protocol serves only files inside the packaged
   renderer directory. The protocol supplies a restrictive CSP and routes
   same-origin data requests through main.
3. Main owns the encrypted session and PKCE exchange state. The renderer asks
   for sign-in, sign-out or a validated application operation; it never receives
   cookies, bearer credentials, refresh tokens or live-channel tickets.
4. One desktop RPC route dispatches an explicit allowlist of actions with Zod
   schemas. Bearer authentication is required independently of any cookies.
   Existing action authorization is retained; desktop transport grants no new
   role or cross-workspace access.
5. Bootstrap returns the same user-safe initial state used by the server pages.
   Dates and other supported action values have a defined wire encoding.
   Current and previous desktop protocol versions remain compatible; other
   versions produce a dedicated update-required response.
6. The renderer retains existing scoped push invalidations and cache behavior.
   Ticket acquisition and the authenticated socket live in main. Reconnecting
   is event-driven and no idle database polling is added.

The RPC/version contract is implemented in `lib/desktop-rpc/` and its tests.
The main-process transport lives in `apps/desktop/src/main/bundled-*.ts`. The server is never allowed to import or execute arbitrary names
provided by the client.

### Native session cache and fresh authorization

Ordinary native reads reuse Better Auth's existing signed `session_data` proof,
with the same 300-second lifetime as web reads. The SDK verifies its signature,
cache version, expiry and exact session-token binding. Neither a browser cookie
nor a foreign account's proof can authenticate the desktop RPC. There is no
independent server TTL or cross-request identity cache.

Main retains this proof beside its bearer in the existing OS-encrypted account
vault. The private request/response header is `x-mikka-session-cache`, bounded
to 16,384 base64url characters. An absent response header preserves the proof;
an empty value clears it. The renderer never receives the proof, bearer,
authentication cookies or private response headers. Old REST routes can renew
the same proof through the SDK's exact `session_data` response cookie; main
retains only that bounded value, never the Cookie header or a cookie jar.

The original money, permission, credential and deletion entry points still
require a fresh database session. A cached RPC identity upgrades once within
that request; a revoked result remains null and cannot fall back to cookies.
Sign-in auditing must succeed before a proof is issued. Password rotation
clears the old proof, while profile updates carry the SDK's already signed new
name/image into the existing bootstrap refresh without another identity read.

`tests/desktop-session-cache.db.test.ts` compares the original
`preferences.getPreferences` action with the old and new native transports,
counting all authentication and business SQL plus PostgreSQL socket response
bytes on warmed connections. The isolated fixture measured 2 queries / 635 B
for web and cached native reads, versus 4 queries / 1,694 B for the old native
transport. Separate cases cover HTTP and REST renewal, tampering, another
account's proof, version changes, expiry, revocation, profile changes and
mandatory fresh reads. This focused measurement does not replace the full
runtime idle and UI acceptance evidence.

## Validation plan

| Requirement | Evidence required |
| --- | --- |
| UI parity | Same dimensions, scale, fixtures, fonts and theme; mask only named dynamic regions; <=0.1% differing pixels per screen |
| Main pages | Coordinator, bot, group, all overview tabs, Artifact window and task dialog |
| Settings | Every reachable settings section, including devices |
| Login and offline | Local sign-in UI, system-browser handoff, nonblank disconnected startup and event-driven recovery |
| Native capabilities | Bridge, notification, badge, updates, translucency, folder selection and deep-link checks |
| Session boundary | Bearer-only RPC, no renderer session/ticket, strict IPC and navigation tests, CSP tests |
| Startup | Same machine/build mode and cold profile; compare time to the same usable UI state |
| Idle | Fixed one-hour wall-clock runs with real isolated DB instrumentation, query/byte totals per client |
| Web compatibility | Before/after screenshots and existing web checks; shared adapter extraction must not change web behavior |
| Delivery | Green draft-PR CI and an unsigned Apple Silicon `Mikka Dev` artifact bound to the disposable Docker production build |

Screenshot filenames, dynamic masks, measurements, SHA, database identity and
application origins are recorded in machine-readable evidence. A short unit
idle-budget test is not represented as the one-hour runtime measurement.

## Environment and risks

- Prefer the current agent VM. Builds and unit checks run there. Use Docker
  Agentic Platform when the required native runtime cannot be exercised there;
  stop disposable machines after use.
- Runtime acceptance uses `next build` and `next start` against independent
  PostgreSQL in Docker or GitHub Actions. Publish the isolated server's port
  for the unsigned test package; do not use `next dev` for acceptance.
  [Alex's later authorization](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6667238449)
  supersedes the original prohibition on merge, deployment and production
  configuration changes. Complete verification and retain a concrete rollback
  before making the necessary production cutover.
- The first baseline build exceeded the current VM's 8 GiB cgroup limit
  (`memory.events`: `oom_kill=1`). Full builds and regression can use a Large
  Docker sandbox; the ordinary Medium sandbox is stopped during this work.
- The issue requires macOS ARM64 evidence. Linux Electron proves shared logic
  and rendering but does not prove macOS Keychain, vibrancy or installer behavior.
  The draft PR's macOS job builds the test package; release remains separate.
- No source is copied from Comma. It is an architectural reference only.
- Main is incorporated with merge commits, never rebase or force-push. Evidence
  is repeated only for code or environment changes that invalidate it.

## Acceptance status

The bundled renderer is present and selected by default in source. This page
does not establish completion of every #1415 acceptance item. Use the
revision-bound records under `docs/acceptance/issue-1415/` and the owning issue
for measured results and remaining gates.
