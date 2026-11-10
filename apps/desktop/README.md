# @mikka/desktop

The Electron desktop for Mikka. It bundles the **same React components, fonts,
tokens and Tailwind styles** as the Vite-built web client. The main window loads
`mikka://app/mikka` from the App, so opening the interface does not download or
server-render a web page. Main forwards authenticated operations to the backend.

Implementation and acceptance evidence:
[`docs/design/desktop-bundled-renderer.md`](../../docs/design/desktop-bundled-renderer.md).

## What differs from the web client

The renderer asks for capabilities, never for a platform name
(`@mikka/protocol/platform`). The shell exposes `window.mikka`
(`packages/protocol/src/bridge.ts`); the web has no bridge and therefore no
desktop capability.

| Capability | v1 |
| --- | --- |
| `app` (version, flavor, runtime) | yes |
| `device.localIdentity` — the daemon on this computer | yes |
| `notifications.system`, `notifications.badge` | yes: 等你/失败 notifications and the waiting-run Dock badge |
| `quota.snapshot` | yes |
| `bundled` session, browser sign-in and live transport | yes; public identity only, credentials stay in main |
| `device.pickRepo` | yes; native directory dialog, validated Git repository |
| General local `settings`, `preview` scheme, saved tabs | deferred |

The bundled renderer cannot read the session token, authentication cookies or
live socket ticket. Main stores the session using OS-backed `safeStorage`,
scoped to the backend and app profile. Insecure Linux `basic_text` storage is
rejected; macOS uses Keychain. See `docs/design/platforms.md`.
Updates come from published GitHub Releases through `electron-updater`. The
cold-start gate checks for five seconds before opening the app. When it finds
an update, it downloads and installs it before entry. A check timeout or
unavailable network lets the app open. Background checks download silently and
offer a restart after the download. **Check for Updates…** reports the result
in a native dialog.

## Run

Run development and acceptance in cloud Linux with the repository's Node 24
and pinned pnpm. The backend uses Vite and Hono/Nitro.

```bash
# terminal 1 — application and API at http://localhost:3000/mikka
pnpm dev

# terminal 2 — the shell
pnpm desktop:dev
```

The dev shell loads local assets and sends backend requests to
`http://localhost:3000/mikka`. It uses the separate `Mikka Dev` data directory
and `persist:mikka-dev` partition, matching the daemon's dev flavor.
`MIKKA_DESKTOP_APP_URL` selects the backend at build time. Compiled-backend
acceptance prepares the isolated database, runs `pnpm generate:agent-ui` and
`pnpm build:app`, then starts the Node output with `pnpm start`. See the
[shared runtime guide](../../docs/operations/web-runtime.md).

## Build and package

```bash
pnpm desktop:build                 # main/preload bundles and dist/renderer/
pnpm --filter @mikka/desktop package:dir   # unpacked app under release/
pnpm --filter @mikka/desktop package:mac   # signed Apple Silicon dmg/zip (release)
pnpm --filter @mikka/desktop package       # local dmg/zip, never publishes
# Ad-hoc signed isolated test package; requires an explicit non-production backend:
MIKKA_DESKTOP_APP_URL=https://your-test-backend.example/mikka pnpm --filter @mikka/desktop package:dev:mac
```

A production build must use an HTTPS app URL. Signing and notarization
credentials belong to the release pipeline, never the repository.

`Mikka Dev` has a complete ad-hoc integrity signature after packaging and fuse
changes. It has **no Developer ID signature or notarization** and is not a
release artifact. The Dev packaging script removes inherited Apple signing
credentials and explicitly enables only this ad-hoc signing on pull requests.
Hardened runtime stays enabled. Because ad-hoc signatures have no Team ID, a
separate Dev entitlement permits loading the packaged Electron framework;
production entitlements do not include that library-validation exception.
See the [electron-builder v26 signing requirements](https://www.electron.build/v26/docs/mac/)
and [Apple's library-validation policy](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation).

Every Dev/acceptance package must pass `codesign --verify --strict --deep`,
actual identity and entitlement checks, and a read of its final Electron fuse
wire. The downloadable Dev package keeps the inspector disabled. None of these
checks changes Keychain permissions or enables a plaintext credential fallback.

## Sign-in

Google and GitHub sign-in open in the system browser, never in an embedded
window. Before opening it, the shell binds a one-shot HTTP listener to
`127.0.0.1` on a random port. The browser finishes OAuth on the web app, which
mints a one-minute exchange code and redirects it to that loopback listener.
Main redeems the code with its retained PKCE verifier and persists the returned
session only after the OS keychain encrypts it. Signup stays in the system
browser with its existing Turnstile protection. The local protocol is for
packaged assets, not an OAuth callback handler.

The loopback's page then opens the app link `mikka-auth://auth/done?id=…`
(`mikka-dev-auth` for Mikka Dev; `protocols` in the electron-builder configs),
so the system brings the app to the front: macOS does not let an app take the
front from the browser by itself. The link carries no code or page; main
accepts only an id it issued in the last ten minutes (`src/main/app-link.ts`,
`open-url` on macOS, `second-instance` on Windows and Linux). The page then
tries to close its tab and otherwise shows 已登录，可以关闭此页 with 打开 Mikka.

In the browser, `continue=google` or `continue=github` starts that provider
without another click. A browser that already has a Mikka web session shows
that account first (以 <名字> 继续 / 换个账号); 换个账号 opens the provider's
account picker.

## Servers

The app connects to Mikka Cloud (the build's `MIKKA_DESKTOP_APP_URL`) or to a
self-hosted Mikka server (#1557; the server side is #1556). The sign-in page
names the server under its card; 更改 opens the server choice. A self-hosted
address is read once at `<address>/api/desktop/discovery` (then
`<address>/mikka/api/desktop/discovery` for a bare host) before it can be
chosen. Main accepts the answer only from that exact origin, never through a
redirect, and uses the base path it reports. Plain HTTP is accepted only for
`127.0.0.1`, `localhost` and `[::1]`.

The discovery document the app reads (`src/main/server-discovery.ts`):

```json
{
  "name": "Acme Mikka",
  "version": "2026.11.6",
  "edition": "community",
  "basePath": "/mikka",
  "desktopProtocol": { "min": 0, "max": 1 },
  "signIn": { "google": false, "github": true, "email": true },
  "minDesktopVersion": null
}
```

`desktopProtocol` may also be a list of versions and `signIn` a list of method
names. A range that ends below this app's protocol (1) asks for a server
update; one that starts above it, a `minDesktopVersion` above an installed
release, or #1415's `426` / `desktop_client_update_required` asks for an app
update. A server that has no discovery but answers `/api/version` is an older
Mikka and asks for a server update.

Each account in the encrypted vault records its server (`server`, absent for
the built-in one). Its bearer is sent only there; the same user id from another
server is refused. Accounts on different servers stay signed in together and
the switcher names each account's server when they differ. The page reloads
when the current server changes, so `app.serverUrl` (share links, browser
pages), `openExternal`, the loopback sign-in (`begin`, `return`, `exchange`),
the live ticket and the local daemon's `--server` all follow the current
account. The renderer CSP has no server origin: the page reaches servers only
through main. `servers.json` beside the vault holds the sign-in target and each
server's public name and version, never a credential. Settings › 账户 › 服务器
switches (sign in on another server as another account) and disconnects (signs
out every account on that server). The hosted rollback renderer
(`MIKKA_DESKTOP_RENDERER=hosted`) stays on the built-in server.

## Transition and rollback

Bundled mode is the default. Set `MIKKA_DESKTOP_RENDERER=hosted` when launching
to select the previous hosted window implementation. Its existing browser
session and `/api/desktop/finish` exchange remain compatible. Remove the variable
to return to bundled mode; application data stays on the same backend.

For an isolated profile, `MIKKA_USER_DATA_DIR` accepts an absolute directory.
Do not point a test run at the production profile. `Mikka Dev` disables all
production desktop updater checks, launch gates and daemon update attempts.

RPC protocol versions 1 and 0 are accepted. The server's fixed
`desktop_client_update_required` response stops incompatible calls and offers
an App update. The old hosted renderer remains supported independently of this
wire protocol. The generated action manifest and explicit Zod registry are
checked together; changing a server export cannot silently omit its desktop
client operation.

## Isolated acceptance

The desktop CI builds the Vite frontend and Hono/Nitro backend against an independent
Postgres and runs Electron with real leased test accounts. Apple Silicon CI
reuses that compiled backend, then tests an actual packaged App before producing
the ad-hoc signed `Mikka Dev` ZIP. The inspector-enabled acceptance bundle is a
harness input only; downloadable and release Apps retain the inspector fuse.

Before account acceptance, `test/native-crypto.mjs` launches that same final
package in three independent macOS processes. Main encrypts random non-credential
canaries, then later processes must decrypt them across a second profile and a
hosted-to-bundled restart. The probe uses the real asynchronous OS storage API,
reports only checks/counts and closed error categories, and never sends plaintext
or ciphertext to the renderer. Availability alone does not satisfy the check.

`test/environment.mjs` starts the local live gateway and compiled backend.
`test/db-metrics.cjs` records query counts and PostgreSQL connection protocol
bytes, excluding SQL, parameters and row data. The short `test:idle-budget`
regression checks request budgets. Historical idle and performance measurements
retain their recorded revision and environment. Current build, release and
acceptance boundaries are in the [runtime guide](../../docs/operations/web-runtime.md).

## Release

**Desktop release** runs on `main` changes matching its application, shared
renderer, daemon, protocol, dependency and release-tool path filters. It also
supports manual dispatch from `main`. A successful normal run publishes a
signed, notarized Apple Silicon macOS GitHub Release after checking its Web,
private UI and sealed-candidate bindings.

There is no version bump or tag to create. The version is
`2026.10000.<workflow run number>` (for example `2026.10000.42` for run 42).
The fixed epoch sorts after the earlier `YYYY.MMDD.HHMM` versions. Run numbers
increase on every push, independent of commit dates, and stay the same on
retries. The release is tagged `desktop-<version>` on the built commit. The
version in `apps/desktop/package.json` is only used for local builds.

The workflow attaches the DMG, ZIP, updater metadata and `SHA256SUMS.txt` to
the published release. Normal notarized releases use `make_latest: true`.
The source, matching Web overlay and sealed assets are rechecked before
publication. Confirm the release tag and **Check for Updates…** result for the
installed app.

New preflights cancel obsolete Web waits. The macOS signing job finishes its
active candidate and keeps only the latest pending candidate. Publication still
requires the source and overlay checks to pass.

The workflow reads existing credentials from Infisical `prod:/platform` through
its workload identity.

| Secret | Purpose |
| --- | --- |
| `APPLE_DEVELOPER_ID_P12_BASE64` | Developer ID Application certificate |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | Certificate password |
| `APPLE_TEAM_ID` | Apple signing team |
| `ASC_API_KEY_P8` / `ASC_API_KEY_ID` / `ASC_API_ISSUER_ID` | App Store Connect notarization credentials, mapped to the release tools' `APPLE_*` inputs |

macOS releases fail the workflow when neither notarization credential set is
present. The manual `skip_notarization` input is for internal builds only;
those builds remain drafts and are invisible to the updater. The release
workflow builds macOS ARM64 only.

Release acceptance on Apple Silicon: confirm Gatekeeper opens the installed
DMG, sign in through the real provider, check the Dock badge and a notification,
and confirm **Check for Updates…** finds the published version.


## Security

- `contextIsolation`, `sandbox`, no Node integration, no `<webview>`.
- The preload exposes a narrow bridge only on the app origin; it never exposes
  `ipcRenderer`, `require` or file paths.
- Main accepts IPC only from the app's main frame and validates every payload
  with the protocol schemas.
- Navigation: only the app origin stays in the window; every other HTTP(S) or
  mailto link, including Google and GitHub sign-in, opens in the system
  browser; everything else is denied.
- Permissions are denied except clipboard writes; system notifications come
  from main, not the renderer.
- No auth token, device credential or arbitrary path crosses the bridge.

## Tests

```bash
pnpm --filter @mikka/desktop typecheck
pnpm --filter @mikka/desktop test
pnpm --filter @mikka/desktop build
```

The unit tests cover URL policy, notification dedupe/rate limits and the
daemon-status mapping. The **Desktop shell** workflow also starts an isolated
web app and runs the Electron window smoke under Xvfb on every desktop change.
