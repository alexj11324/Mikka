# Required-update connections

The first required-refresh patch (#1135) blocked new fetches and paused SWR,
but an existing streaming response could remain open. Computer EventSource
connections and read-receipt beacons also bypassed the fetch pause.
Occurrence4/10, impact4/10, score16: an idle stale page can keep database-backed
streams alive even while the blocking update dialog is shown.

The update signal now aborts already-open same-origin business fetches/bodies,
while preserving the caller's own abort signal and the public version probe.
The shared computer EventSource closes and cannot reconnect on visibility or
subscription. Read receipts no longer send beacons during the required update.
The dialog and mounted draft components are unchanged from #1135; its reviewed
light/dark/narrow production screenshots remain the visual reference.

A real loopback HTTP SSE regression failed before the change: the stream was
still open until the test server forcibly closed it. With the change, reading
the body rejects with AbortError immediately. It also verifies caller-provided
Request cancellation, metadata access and beacon suppression. EventSource tests
verify close, no visibility reconnect and subscription cleanup. These are Node
and DOM source tests; no browser tests run.

A concurrent review also found XMLHttpRequest-based chat uploads. Uploads now
share the update abort signal: both chunked same-origin uploads and direct R2
PUTs stop, with no next chunk, completion or cleanup DELETE while blocked.
The upload ticket remains available; ordinary user cancellation keeps its
existing cleanup. A regression failed on the original implementation, then
all four upload tests passed.

The final PR records current source checks, production-build and API acceptance
results. Normal conversation history remains server-durable, with the existing
sequence/cursor resume after refresh. No production data is written by tests.

The independent NoVNC viewer WebSocket now also disconnects on the update
signal, retaining its final frame. An already-aborted signal and an update
while the module loads cannot create a late connection. The existing viewer
unmount path removes the listener and does not issue a device-stop command.
Four regression cases plus the two existing cases pass (6 total), with a
verified red run against the prior implementation. Typecheck passes.

## Version-bound verification

Runtime source revision: `863e6072d2948d6adff598a481b42a04e23e606e`,
including the integration of main `b0553336f95c35e1f186dd9207fbdaa244b78ca5`.
The final documentation/screenshots commit changes no runtime code.

- Full lint and typecheck passed; 69 library units, 28 DOM/SWR, four upload
  and six computer-screen cases passed. The network/AppBuild/EventSource
  regression group passed 13 cases, including the actual HTTP response body.
- A fresh production build passed at that exact revision.
- Six normal leased-session HTTP acceptance checks passed against the local
  production build at `http://localhost:3110/mikka`, isolated real Postgres
  database `mikka_refresh_stream_e2e` on loopback port 55432. They cover bounded
  chat history, conditional 304, unchanged version, cursor delta and peer
  isolation. The fixture response was 82,002 bytes full versus 2,370 delta,
  with zero response-body bytes on 304; these are fixture HTTP bytes, not
  production savings or provider billing bytes.
- Light, dark and narrow production-build captures were visually reviewed
  after the real blocking dialog appeared. A synthetic newer version
  response selects this state; application authentication uses the normal
  leased-session helper. No browser tests or live model calls ran.

Reviewed captures: [light](../screenshots/2026-11-03-required-refresh-connections/required-refresh-light.png),
[dark](../screenshots/2026-11-03-required-refresh-connections/required-refresh-dark.png),
[narrow](../screenshots/2026-11-03-required-refresh-connections/required-refresh-narrow.png).

The Git-linked CI run is recorded on the PR. Deployment and real billing
results remain separate checks; passing isolated acceptance does not establish
a total production egress reduction.
