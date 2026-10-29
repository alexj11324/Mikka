# @mikka/desktop

The Electron shell for Mikka. It renders the **same Next.js UI** as the web
client and adds the native abilities the web cannot have. There is no second
renderer and no UI fork.

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
| `auth`, `settings`, `device.pickRepo`, `preview`, saved tabs | deferred |

Sign-in reuses the web session in this window. The `@better-auth/electron`
keychain/JWT flow, device linking and the `mikka-preview:` scheme need server
and release work that is not part of this phase; see
`docs/design/platforms.md`. Updates come from the published GitHub Release via
`electron-updater`: the app checks on launch and from **Check for Updates…**,
asks before downloading, and asks before restarting to install.

## Run

```bash
# terminal 1 — the web app (Next.js at http://localhost:3000/mikka)
pnpm dev

# terminal 2 — the shell
pnpm desktop:dev
```

The dev shell loads `http://localhost:3000/mikka` and uses the `Mikka Dev`
data directory and the `persist:mikka-dev` session, matching the daemon's dev
flavor. `MIKKA_DESKTOP_APP_URL` overrides the URL.

## Build and package

```bash
pnpm desktop:build                 # dist/main.cjs, dist/preload.cjs
pnpm --filter @mikka/desktop package:dir   # unpacked app under release/
pnpm --filter @mikka/desktop package:mac   # signed Apple Silicon dmg/zip (release)
pnpm --filter @mikka/desktop package       # local dmg/zip, never publishes
```

A production build must use an HTTPS app URL. Signing and notarization
credentials belong to the release pipeline, never the repository.

## Sign-in

Google and GitHub sign-in open in the system browser, never in an embedded
window. The browser finishes OAuth on the web app, mints a one-minute,
single-use token and returns through the `mikka-desktop://auth` protocol. The
shell loads `/api/desktop/finish`, exchanges that token for its own session
cookie and continues to the requested page. The packaged app declares the URL
scheme in `electron-builder.yml`; the shell also registers it at launch.

## Release

Bump `apps/desktop/package.json`, push a tag named `desktop-vX.Y.Z`, and run the
**Desktop release** workflow (or start it manually with that tag). It builds the
Apple Silicon macOS installer, signs and notarizes it, and attaches the DMG,
ZIP and `SHA256SUMS.txt` to a **draft** GitHub Release. Publish the draft only
after installing it on Apple Silicon.

Repository secrets used by the workflow:

| Secret | Purpose |
| --- | --- |
| `APPLE_DEVELOPER_ID_P12_BASE64` | Developer ID Application certificate |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | Certificate password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS notarization |
| `APPLE_API_KEY_P8_BASE64` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | Alternative notarization auth |

macOS releases fail the workflow when neither notarization credential set is
present; the manual `skip_notarization` input is for internal builds only.
The release workflow builds macOS only and does not publish automatically.
The updater ignores draft releases, so updates reach users only after the draft
is published.

Before publishing the draft:

1. Confirm the certificate is **Developer ID Application**, not Apple Development.
2. Add one notarization credential set; without it the macOS job fails by design.
3. Install the ARM DMG on Apple Silicon, confirm Gatekeeper opens it, sign in
   through the real provider, and check the Dock badge and a notification.
4. Publish the draft, then confirm **Check for Updates…** finds it.


## Security

- `contextIsolation`, `sandbox`, no Node integration, no `<webview>`.
- The preload exposes a narrow bridge only on the app origin; it never exposes
  `ipcRenderer`, `require` or file paths.
- Main accepts IPC only from the app's main frame and validates every payload
  with the protocol schemas.
- Navigation: only the app origin stays in the window; every other HTTPS or
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
