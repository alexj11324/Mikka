# Native authentication-return navigation diagnosis

`native-document-probe.mjs` runs real Electron with the product's sandboxed
preload. It has no account, database, daemon, backend or external network request.
It uses one temporary owned profile, a local custom-scheme document and an
explicit parser-blocking script gate. The gate controls event order; it does not
add a sleep or retry a failed evaluation.

Run it once in an already prepared native test environment, as the normal
non-root test user. From the repository root on Linux:

```sh
xvfb-run -a node apps/desktop/test/native-document-probe.mjs
```

Use the existing Electron installation and existing sandbox setup. The launcher
performs its ordinary runtime preflight. The child receives only the listed OS,
display and locale variables, including `XAUTHORITY`; application/database/auth
environment is not inherited. No sandbox flag, keychain or service is replaced.

The probe verifies three distinct facts:

1. `about:blank` can be loaded and the real product bridge can be available while
   the initial bundled document is still loading. An event waiter armed at this
   point receives that initial document's `DOMContentLoaded`, not a later
   authentication-return navigation.
2. A loaded bundled document can use `history.replaceState` to reach the normal
   `/mikka/sign-in` and localized auth paths. Its `performance.timeOrigin` and
   document title remain unchanged, and no additional `DOMContentLoaded` fires.
   The application-namespace predicate accepts these paths with the existing
   DCL and IPC gates; an exact root-URL matcher would wait for a navigation that
   this ordinary SPA transition does not require.
3. Waiting for the actual bundled document's `DOMContentLoaded` before arming the
   next navigation event distinguishes the second document. An ordinary pending
   renderer evaluation is destroyed by that second navigation, demonstrating
   the failure mechanism independently of authentication.

The printed JSON contains file hashes, runtime versions, bounded navigation
classes (`blank`, `bundled-root`, `bundled-route`, `other`), fixed phase names and
assertions. The legacy `document` field counts main-frame `framenavigated`
events, including History updates; it is not an actual DOM document identifier.
No path or query is recorded. The JSON includes `acceptanceRun: false`:
this controlled diagnosis does not prove an actual provider flow, the exact
unrecorded call site in the failed Mac run, installation readiness, cold-start
performance or the one-hour idle budget. The original failed report remains
evidence of those incomplete checks. Success also requires the owned Electron
process to close; temporary files are removed only after that succeeds.

The installed Playwright URL matcher and actual `Frame.waitForURL` method also
have a source-only regression in `native-document.test.mjs`. Controlled event
delivery checks already-loaded SPA paths, completed `about:blank` before the
real document's DCL, missing IPC, and rejection of foreign origins or non-app
namespaces. Run it without launching Electron:

```sh
node --test apps/desktop/test/native-document.test.mjs
```

These controlled cases do not identify the destination of a historical
`other` navigation receipt. The older classifier did not retain that URL, so
the receipt alone cannot prove which path caused a failed acceptance wait.
