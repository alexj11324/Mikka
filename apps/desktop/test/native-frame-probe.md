# Sandboxed frame diagnosis

This is a credential-free Electron diagnostic for the frame lookup that failed
in lifecycle acceptance at phase1 `052fd7ae`. It is not a replacement for the
authenticated lifecycle run or macOS acceptance.

Run only after the shared build finishes, as the existing non-root test user in
the intended checkout. Do not change Chromium sandbox permissions or add
`--no-sandbox`. Reuse the already prepared display/session environment.

The locked package is Electron **45.1.0**. If its `dist` is absent, use the
installed package's normal installer; it verifies the bundled checksums and
does not rebuild the application:

```bash
node -e 'const a=require("node:assert/strict");a.equal(require("./apps/desktop/node_modules/electron/package.json").version,"45.1.0")'
env -u ELECTRON_OVERRIDE_DIST_PATH -u ELECTRON_INSTALL_PLATFORM -u ELECTRON_INSTALL_ARCH -u ELECTRON_SKIP_BINARY_DOWNLOAD node apps/desktop/node_modules/electron/install.js
```

Then run once, with the ordinary existing test user's permissions:

```bash
xvfb-run -a node apps/desktop/test/native-frame-probe.mjs
```

The driver compiles only the actual protocol/CSP and preload into a private
temporary directory (approximately 14 KB + 10 KB), then opens one real Electron
window. Its empty transport has no database, credentials or external requests.
The child environment is an explicit OS/display allowlist, including the
`XAUTHORITY` file reference supplied by `xvfb-run`; no application credentials
are inherited. The first Medium attempt stopped in display preflight because
that reference was omitted, so it produced no iframe evidence. Keep that failed
record separately from a run with the complete display environment.
It records the old
immediate name lookup, actual frame events, DOM state, an element-owned frame
lookup, and the unchanged IPC/Node/parent/API isolation checks. The main-frame
transport is exercised once to show the observer is active, while opaque-frame
transport calls must remain zero. No sleeps, timing thresholds, frame security
attributes, or browser security settings are changed.

The JSON record reports only the fixture's closed state, booleans, fixed names,
types, counts and timestamps. A successful process must also report `closed:
true`; its private profile/output directory is removed only after Electron has
closed. If the old lookup succeeds, the run is useful boundary evidence but
does not reproduce the original lookup failure. Preserve that distinction.
