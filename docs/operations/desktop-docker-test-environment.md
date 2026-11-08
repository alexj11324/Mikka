# Public Docker desktop test environment

Issue #1415 needs an unsigned desktop package that can reach a disposable HTTPS
backend from outside the build VM. `isolated-docker` is an explicit test-account
adapter for that service. The existing `isolated-ci` loopback adapter, its CLI,
and the localhost production/idle harness keep their original behavior.

## Ownership and immutable binding

Only the two issue-owned Docker sandbox UIDs in
`scripts/test-accounts/docker-target.mjs`, and their published TCP port **3000**,
are accepted. `verifyDockerOwnership` sends authenticated **GET** requests to the
fixed `https://connect.docker.com/sandboxes/v1/` API for the sandbox and its
`/ports` collection. It checks the sandbox UID/name, running status, endpoint
owner, unique publication UID, port, protocol and exact HTTPS URL against both
live responses. It also checks the checked-out Git SHA and the specific local
database target. No redirect, arbitrary management endpoint, resource creation,
port publication, provider action or production setting change is performed.

The verifier returns a frozen, process-local, one-use receipt. A private WeakMap
records its authority for at most 60 seconds. Serializing, copying, fabricating,
replaying or changing the receipt's origin, SHA or database cannot authorize
bootstrap. The owner's short-lived access token remains in memory; it is never
placed in a descriptor, application environment, application credential store,
log or CLI argument.

`bootstrapDockerEnvironment` consumes this receipt before connecting to
PostgreSQL. The connection must be TCP `127.0.0.1:5432`, role `e2e`, schema
`public`, with a `*_e2e` database. It verifies the actual server and SQL identity,
then requires no existing environment marker, metadata namespace, descriptor or
application users. Normal schema migrations may have run already. It does not
adopt an existing account database or change its origin/SHA binding.

The private descriptor contains the sandbox/publication identity in its
fingerprint and an HMAC signature made with the new instance's existing
attestation key. The key stays in the isolated database. Startup, account-pool
operations and the read-only application attestation validate the exact marker
and descriptor signature. The same lease, generation, cleanup, quarantine and
evidence-scanner rules apply to both adapters. Restart loads and verifies the
existing descriptor; it never runs bootstrap again. A new origin, publication,
revision or database requires a new empty test database and a new descriptor.

## Owning harness setup

The owning agent first creates a new disposable database and applies the normal
migrations/setup at the final, fixed branch SHA. It supplies matching
`E2E_DATABASE_URL`, `MIKKA_DATABASE_URL` and `DATABASE_URL` values through the
existing private runner environment, and sets:

- `BETTER_AUTH_URL` to the exact verified Docker publication origin;
- `E2E_BASE_URL` to that same origin when present;
- `MIKKA_TEST_DEPLOYMENT_SHA` to the checked-out 40-character commit SHA;
- `MIKKA_TEST_ENVIRONMENT_FILE` to a new private descriptor path;
- `BETTER_AUTH_SECRET` through the private runner's existing secret handling.

The explicit bootstrap command is:

```sh
node scripts/test-accounts/docker-bootstrap.mjs --sandbox <authorized-uid> --output <private-descriptor-path>
```

It reads a bounded JSON object with `accessToken` from stdin. The owning runner
must provide that object directly from memory, close stdin, and keep Docker
credentials out of the child's environment and command arguments. A saved JSON
receipt or a user-controlled `approved` flag is not supported. The runner does
not send a Docker PAT to this command and does not write a credential file.

Build the production application at the same SHA with
`MIKKA_TEST_DEPLOYMENT_SHA` present, using the normal build flow. Then start:

```sh
node apps/desktop/test/docker-environment.mjs
```

This entry point requires the existing signed descriptor and actual database
marker. It refuses another compiled SHA, base path, trusted-auth origin, a
Vercel runtime or a configuration enabling broad `trustHostHeader`. It does not
create accounts, migrate data, mutate Docker resources, or deploy an app.

## HTTPS origin and real live channel

Docker terminates public TLS and forwards to the sandbox's port 3000. The test
server checks the original raw Host header exactly against the descriptor;
duplicate Host, conflicting forwarded host/protocol/port, ambiguous forwarding
claims and non-origin-form request targets are rejected before the API executes.
No request header selects the trusted origin.

The outer Node HTTP listener binds port 3000 and retains the normalized
origin-form path after ingress validation. It passes the real Node request and
response to the compiled Nitro adapter in `.output/server/mikka-docker.mjs`.
`createDockerRuntime` receives the descriptor's fixed HTTPS origin. The build
receipt requires `trustProxy: false`, the same source revision and the matching
test revision. The adapter owns no listener or process signal handlers.

Shutdown closes owned connections, drains the application response/`waitUntil`
lifecycle and closes Nitro, then closes the local Worker. The entry point and
its validation are in `apps/desktop/test/docker-environment.mjs` and
`scripts/start-app.mjs`. Its origin handling is specific to this disposable
environment.

The service starts the real device-gateway Worker in local Miniflare. Only its
existing exact `/v1/live/<channel>/{socket,push}` and
`/v1/devices/<uuid>/{socket,push,status}` routes are streamed through the same
public port. WebSocket upgrades retain their capability protocol and duplex
stream. All actual ticket, owner/workspace and push-secret checks remain in the
existing Worker. The private upstream target is fixed to the created loopback
Worker; it cannot be supplied by a URL or request header. Public live/device
tickets therefore contain reachable `wss://` URLs, not a loopback address on the
desktop user's machine. No additional public port is needed.

## Acceptance evidence

Source tests cover authenticated fixed-endpoint ownership reads, fabricated and
replayed receipts, wrong sandbox/publication/port/origin/SHA/database, existing
users/markers/descriptors, descriptor tampering, exact ingress headers, compiled
revision mismatches and HTTP/WebSocket proxy behavior. These are guard tests;
they do not by themselves claim a real public runtime or OAuth acceptance.

The owning runtime acceptance must record its exact final SHA, sandbox UID,
publication origin, new database name, successful real HTTPS environment
attestation, real normal email sign-up/sign-in through the shared leased-account
helper, authenticated RPC, and real live connection/cleanup. Real Google/GitHub
OAuth still requires an existing authorized provider/browser identity and the
existing staging OAuth proxy configuration; this adapter supplies neither and
must not be reported as an OAuth provider round trip.
