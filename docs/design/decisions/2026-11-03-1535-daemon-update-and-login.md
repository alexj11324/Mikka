# Updating and signing in are both required after daemon quarantine

- Date: 2026-11-03
- Source: Alex, Neon egress investigation: 「错了，是必须进行更新，并且重新登录之后才可以」, after authorizing disconnecting the daemon whose remote update failed.
- Rule: —
- Replaces: —

A quarantined daemon's previous credential remains revoked. Updating alone does
not revive it, and a new login cannot admit a released binary older than the
fixed minimum (`0.0.375`). Check both the HTTP client version and registration
metadata, so a current header cannot register an old binary.

The server's normal credential and ownership fences remain authoritative. An
already leased run may finish using its original authenticated claim credential;
a fresh credential cannot inherit that grace by sharing the owner. Heartbeat
and device-command acknowledgement remain upgrade-control channels only. These
exceptions never admit a revoked credential. No new work is claimed below the
minimum. Authenticated cloud workers and the existing source-version contract
remain supported.

The target's production credential was revoked separately under Alex's explicit
instruction. This code introduces no bulk revocation or production data change.

Review tightened the grace to the request's specific run ID and its original
claim token; owning any run does not admit repos, computer, other runs or new
claims. Obsolete command polls return only update/restart commands and version
metadata without querying business work. Obsolete heartbeats skip harness
provisioning and Factory dispatch, and renew only live runs attributed to the
original token. Business message acknowledgments are not upgrade controls.
