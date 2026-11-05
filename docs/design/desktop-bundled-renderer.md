# Bundled desktop renderer

Tracks [#1415](https://github.com/alexj11324/Mikka/issues/1415). Decision:
[2026-11-05](decisions/2026-11-05-1615-desktop-bundled-renderer.md).

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

The implementation and final RPC/version contract are recorded with its tests
in this PR. The server is never allowed to import or execute arbitrary names
provided by the client.

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
- The updated issue explicitly prohibits Vercel deployments. Run `next build`
  and `next start` against an independent `mikka_e2e` PostgreSQL in Docker or
  GitHub Actions. Publish only that test server's port for the unsigned test
  package. Never use `next dev` for acceptance or change Vercel settings.
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

Implementation and runtime validation are in progress. No item in #1415 is
marked complete until its recorded evidence satisfies that item.
