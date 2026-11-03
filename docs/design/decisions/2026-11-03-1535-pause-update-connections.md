# Pause business connections while an update is required

- Date: 2026-11-03
- Source: Alex, Neon traffic investigation: 「弹窗期间应该暂停他的所有请求呀，直到它刷新新版为止呀」; also requested parallel implementation and verification.
- Rule: —
- Extends: [2026-11-03-1437](2026-11-03-1437-required-app-refresh.md)

When a page knows it requires an update, stop new business requests and abort
already-open business fetch bodies and event streams. Do not reconnect when the
page becomes visible again. Suppress read-receipt beacons while blocked.
Keep the public version check and the navigation/download needed for updating
available. The blocking dialog retains the existing page and draft state until
refresh; background model execution remains durable on the server.

Independent daemon processes have their own update and credential lifecycle;
a browser popup does not control every device owned by the account. Their
minimum-version and reauthentication requirements must be verified separately.
