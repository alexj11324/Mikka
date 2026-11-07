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
replica is requested only when an authorized device read needs it, with a bounded
one-second reply window. Device connection claims follow PostgreSQL notification
commit order, so a replacement connection closes the previous one across
replicas without relying on their clocks. A lost database listener closes its
sockets: normal client reconnection obtains a fresh snapshot and resumes push.
The next connection, event or scheduled job reconnects the database session;
there is no database reconnect poll.

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
  ticket expiry, revision compatibility, device wakes and presence.
- `pnpm test:api`: real loopback WebSocket upgrade using Nitro's installed Node
  adapter and the HTTP security-header wrapper.
- `pnpm test:idle-budget`: existing idle-screen request budget.
- `pnpm test:live-db` with the required isolated PostgreSQL 17 test database:
  two independent app gateway instances sharing live events, daemon wakes,
  presence and scheduler leadership, including leader handoff.
