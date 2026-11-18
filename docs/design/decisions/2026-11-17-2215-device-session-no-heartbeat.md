# A device works only while it holds its gateway session; there is no heartbeat and no fallback

- Date: 2026-11-17
- Source: Alex, after one daemon stuck on 0.0.524 polled the heartbeat every 18 seconds (about 2,200 Neon queries an hour): 「我觉得应该彻底废除心跳模式，如果要继续用，必须更新daemon」, 「不要给fallback」, 「daemon太旧就必须先更新才能用」. Reference: Capy's desktop client keeps one WebSocket tunnel, pings it every 10 seconds, ties sessions to that tunnel, and closes it with code 4001 when the client must update. It has no HTTP heartbeat.
- Rule: —
- Replaces: the long-poll fallback in [Device work is pushed](2026-11-03-2030-device-push-gateway.md), and the heartbeat and command-poll update channels in [Updating and signing in are both required](2026-11-03-1535-daemon-update-and-login.md)

## Rule

A daemon is usable only while it holds its device gateway WebSocket. The open
socket is the device's session: it is how the server knows the device is online
and how it knows the device's runs are alive. Nothing on the daemon sends a
request on a timer to prove it is alive.

- **No heartbeat.** `POST /v1/devices/:id/heartbeat` is removed. Run leases,
  presence and Factory re-dispatch follow the session, not a 15 second beat.
- **No fallback.** When the socket is down the daemon only reconnects the
  socket, with jittered backoff from 0.5 to 30 seconds. It does not long-poll
  `/commands`, does not poll run controls or reviews, and claims no work. A
  server without a device gateway has no devices.
- **No grace for old daemons.** A daemon below the minimum version gets
  `426 daemonUpgradeRequired` on every device route, including the ones that
  used to deliver update commands. The gateway closes its socket with `4001`.
  The person updates the daemon and signs in again.

## Session

- The daemon opens the socket with its ticket, then pings every 10 seconds. The
  gateway answers pings without waking and without a database write.
- The gateway reports `connected` when a device socket opens and `disconnected`
  when it closes or has sent nothing for 30 seconds, after a 30 second grace in
  which a new socket cancels the report. It retries each report until the
  application acknowledges it. A run-recovery backstop asks the gateway for the
  status of every device that holds a lease, so a lost report cannot keep a run
  alive.
- `connected` records the session, runs Factory re-dispatch and invalidates the
  device list. `disconnected` ends the leases of the device's runs, which the
  existing run recovery retries elsewhere or fails.
- A run lease lasts as long as the session that claimed it. Revocation, stop
  and policy changes still end a lease at once and are pushed to the daemon.
- Nothing rechecks a running run on a timer. The change that takes a run's
  authority away stops the run itself, once it has committed, and pushes the
  stop to the daemon: archiving its Bot, deleting its task, a member leaving or
  being suspended (with any Bot handed over), a Bot taken over, deleting the
  workspace or the account (`lib/run-authority-stop.ts`). Alex, 2026-11-18: no
  15 second recheck; push the stop when the change happens.

## Reports instead of beats

The daemon still tells the server about changes, once, when they happen:
command receipts, a failed auto-update, harness or model changes, device type
and computer use. These go to `POST /v1/devices/:id/report`, which renews
nothing. Work, device commands, run controls, reviews and new daemon releases
are pushed through the socket as a `work` signal; the daemon then reads them
from the existing routes.

## Time-limited credentials

- Task Secret egress capabilities are checked against the live run and session
  when used, so they no longer need a 90 second renewal.
- A cloud worker's token is rotated once, an hour before it expires, by a single
  scheduled request. That is a deadline, not a poll.
