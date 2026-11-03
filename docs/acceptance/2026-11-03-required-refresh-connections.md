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
