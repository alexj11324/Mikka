# Self-hosted realtime and scheduling

The community `node-server` build includes the WebSocket service used by Web,
desktop and the Mikka daemon. No Cloudflare account, Worker, or Mikka account is
required. Set the normal `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, database URLs
and `CRON_SECRET` from the self-hosting deployment guide.

## Gateway selection

With no `DEVICE_GATEWAY_URL`, community servers
issue tickets for their own `/mikka/v1/live/<channel>/socket` and
`/mikka/v1/devices/<deviceId>/socket` endpoints. The base path is `/mikka`, matching
the current frontend/API build. TLS reverse proxies must forward the configured
Host and support WebSocket upgrades on those paths.

The gateway signing key uses the installation's persisted
`DEVICE_GATEWAY_PUSH_SECRET`, or derives a key from `BETTER_AUTH_SECRET` with a
separate HMAC domain when no explicit key is present. It is never returned to a browser or daemon. Tickets use
the existing `mikka-ticket-...` WebSocket subprotocol. Live tickets expire after
five minutes; their existing clients obtain fresh authenticated tickets. A
daemon's ticket authorizes connection, while the socket remains open after the
ticket expires. Work and command APIs still check current device authority.

Setting both Worker variables keeps the existing Cloudflare transport for live
and device traffic. An incomplete or malformed override fails closed rather
than changing transports silently. Official cloud deployments keep the Worker
configuration and do not enable the community fallback.

## Multiple replicas

Each app process holds its own sockets and one direct PostgreSQL `LISTEN`
session. Post-commit notifications carry invalidation keys or a device ID, never
conversation text, credentials or commands. The same database distributes them
to every replica; requests do not need sticky routing. Supply
`MIKKA_DATABASE_URL_UNPOOLED` when using a transaction-only pooler. Ordinary
PostgreSQL uses `MIKKA_DATABASE_URL`; known Neon pooler URLs are converted to their
direct endpoint by the existing connection helper.

Device ping/pong and presence timestamps remain in memory. Presence on another
replica is requested by an authorized device read or its signed live watch, with
a bounded one-second reply window. Device connection claims follow PostgreSQL notification
commit order, so a replacement connection closes the previous one across
replicas without relying on their clocks. A lost database listener closes its
sockets: normal client reconnection obtains a fresh snapshot and resumes push.
The next connection, event or scheduled job reconnects the database session;
there is no database reconnect poll.

## Device sessions

A daemon works only while it holds its device socket; there is no heartbeat
and no fallback poll ([decision 2026-11-17-2215](design/decisions/2026-11-17-2215-device-session-no-heartbeat.md)).
The daemon pings every 10 seconds and the gateway answers in memory. A device
is online while its socket is open and it connected or pinged within the last
40 seconds: the daemon's 30-second silence limit plus one ping.

The replica holding a device socket reports the device's session to the
application in its own process, without an HTTP request:

- `connected`, once PostgreSQL has ordered the socket's claim.
- `disconnected`, 30 seconds after the socket closes, unless any replica
  claimed a newer socket for the device in the meantime. A socket replaced by
  a newer one (close code `4000`) is never reported closed.

A failed report is retried in that process with backoff from 1 to 60 seconds,
in order per device. After a lost database listener the replica still reports
the closed sockets after the grace; the application ignores a report for an
older socket. A replica that shuts down reports nothing more: its daemons
reconnect to another replica, which reports `connected`, and the application's
run-recovery backstop asks the gateway's status endpoint about any device that
does not return.

Device sockets close with `4000` when replaced, `1012` when the gateway
restarts or loses its database listener, and `4001` only when the daemon must
update. Browser live sockets keep `4001` for an expired ticket or a revoked
session.

Device-dependent live reads negotiate `presence=1`, then register the short-lived
grant issued by the ordinary authenticated read. The gateway acknowledges only
that grant's device ids and home channel, until the earlier of its expiry and the
socket ticket's expiry. Online/offline transitions push the existing device-list
and thread-list keys; pings perform no SQL. Presence is the device session
described above, not a heartbeat. Closing, replacing or expiring a watch
releases its observers.

Cross-replica observers also watch the publishing PostgreSQL session's advisory
lock. In addition to its one `LISTEN` session, each app replica uses at most 32
direct waiter sessions, shared by remote source and counting both active and
closing waiters. Local devices add no waiter. The waits issue no periodic SQL or
heartbeat writes. Only these dedicated sessions set PostgreSQL's
`client_connection_check_interval=1000`: an internal check of the kernel socket
while a query is blocked, so a dead observer does not leave its backend waiting
indefinitely after the kernel detects the disconnect.

The last subscriber cancels its exact waiter query, waits for the server's
response and closes the session. Cancellation may briefly open one extra
protocol connection per closing waiter, using the same TLS settings; it starts
no SQL session. Unconfirmed cleanup retains its capacity reservation for that
app process. Producer-session loss or a failed wait revokes presence coverage
and the client catches up. Network blackholes still depend on PostgreSQL/TCP
detecting the broken connection. At the connection limit, the gateway explicitly
refuses coverage and the client's existing fallback remains active.

This transport does not make the local Workflow world distributed. Deploy one
Workflow execution node with persistent storage until a distributed Workflow
world is configured, as described in the self-hosting design.

## Scheduled work

The built-in minute trigger dispatches the existing cron handlers with
`Authorization: Bearer <CRON_SECRET>`. It uses the same schedule table as the
Cloudflare Worker. Durable timers still handle due work; the reconciliation
safety sweep stays at 15 minutes. Empty minutes perform neither HTTP requests
nor database reads. One PostgreSQL advisory-lock owner runs the scheduled work
when multiple app replicas are present.

Set `MIKKA_EXTERNAL_CRON=1` to disable the built-in scheduler when an external
scheduler already owns it. A community server using its own Cloudflare gateway
can still use the built-in scheduler. `MIKKA_EDITION=cloud` retains external cron.

The optional Cloudflare cron Worker takes its destination as a deployment
variable, for example `wrangler deploy --var MIKKA_URL:https://your-server/mikka`.
The official release helper supplies and verifies its existing production URL
explicitly; the checked-in Worker configuration has no hard-coded destination.

## Verification

- `pnpm test:device-gateway`: built-in and Worker protocol, tenant scoping,
  ticket expiry, revision compatibility, device wakes, presence and device
  session reports.
- `pnpm test:api`: real loopback WebSocket upgrade using Nitro's installed Node
  adapter and the HTTP security-header wrapper.
- `pnpm test:idle-budget`: existing idle-screen request budget.
- `pnpm test:live-db` with the required isolated PostgreSQL 17 test database:
  two independent app gateway instances sharing live events, daemon wakes,
  presence and scheduler leadership, including leader handoff, producer-session
  termination, the try-to-wait race, last-observer/stop connection release and
  the physical backend disappearing after an observer socket is lost.
