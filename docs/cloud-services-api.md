# Mikka Cloud services API

The public repository contains the self-hosted **client**. The issuer,
official GitHub App broker, push relay and hosted-credit endpoints are in the
private `alexj11324/mikka-cloud` repository. Existing public functionality is
not moved. This contract belongs to #1564–#1567.

## Address and registration

`MIKKA_CLOUD_URL` defaults to `https://app.aspectlylabs.com/mikka/cloud`.
Every path below is relative to that configured base. The server operator
controls this URL; an HTTP request cannot supply another cloud endpoint.
HTTPS is required except for loopback development. An unconnected community
installation sends no cloud requests.

`POST /v1/servers/register`, JSON:

```json
{"origin":"https://mikka.example","basePath":"/mikka","name":"Example team"}
```

Returns 201 with `serverId` (UUID), `serverSecret` (`mcs_` plus 32 random
bytes in base64url), `redirectUri`, `authorizationEndpoint`, `tokenEndpoint`.
The callback is exactly `origin + basePath + /api/cloud/callback`; no query,
fragment, wildcard or caller-selected redirect is accepted. Registration is
IP limited. Unclaimed registrations expire after 30 days.

The local administrator is explicitly named by
`MIKKA_SERVER_ADMIN_USER_IDS` (comma-separated local user IDs). Workspace
administration does not imply server administration. Registration, team keys
and whole-server revocation require a fresh local session and server authority.

## Personal binding

Open `/oauth/authorize` with `response_type=code`, `client_id=serverId`,
the exact `redirect_uri`, `code_challenge_method=S256`, `code_challenge`,
space-separated `scope` and an opaque `state`. The self-hosted client stores
the hashed state for ten minutes, bound to the initiating user and exact
session. Its verifier is encrypted. A returning cloud identity never chooses
the local user.

After consent, the issuer redirects to the registered callback with `code`
and `state`. Exchange at `POST /oauth/token` using form encoding:

| Grant | Required fields |
| --- | --- |
| `authorization_code` | `client_id`, `client_secret=serverSecret`, `code`, `code_verifier`, `redirect_uri` |
| `refresh_token` | `client_id`, `client_secret=serverSecret`, `refresh_token` |
| `client_credentials` | `client_id=serverId`, `client_secret=serverKey`, optional narrower `scope` |

Body credentials or HTTP Basic are supported; do not send both. A successful
response has this shape (all shown credentials are placeholders):

```json
{
  "access_token":"<opaque ES256 JWT>",
  "token_type":"Bearer",
  "expires_in":3600,
  "scope":"github push models",
  "refresh_token":"<opaque rotating token, user grants only>",
  "refresh_expires_in":2592000,
  "server_id":"<UUID>",
  "workspace_id":"<billing workspace UUID>",
  "subject":"user:<cloud user ID>",
  "grant_type":"user"
}
```

Refresh tokens expire in 30 days and rotate after each successful use.
Reusing one revokes its entire family. The public client serializes refresh
with a PostgreSQL row lock shared by all replicas. Refresh happens on demand
when fewer than 60 seconds remain; there is no timer or polling. An ambiguous
rotating-refresh failure requires reconnecting rather than replaying it.

Scopes are `github`, `computer`, `push`, `live`, `models`, `connectors`.
The first rollout enables `github`, `push`, `models`. Hosted compute remains
blocked on #1569; live relay/connectors remain deferred under #1570.

## Team server keys and billing identity

The cloud management page at `/manage` creates a key for a registered server
and a selected team billing workspace. The key is `mkc_` plus 32 random
base64url bytes, displayed once; cloud storage keeps a digest. It has explicit
scopes and an optional monthly limit in integer micro-USD.

Each capability request uses `Authorization: Bearer <access_token>`. A team
grant also supplies `X-Mikka-Actor`, the lowercase hex HMAC-SHA256 of the
local user ID under the registration `serverSecret`. This opaque identifier
supports per-person limits without transferring the local user ID.

A personal binding takes precedence over the server key. If that personal
binding is revoked or lacks the requested scope, the operation fails; it does
not silently charge the team. Explicitly disconnecting the personal binding
allows the administrator-configured team key to apply afterward.

`GET /v1/me` returns `serverId`, `subject`, `workspaceId`, `grantType`,
`scopes`, `expiresAt`, `monthlyLimitMicroUsd`. It permits a team token without
an actor for connection verification; capability endpoints require one.

## Verification and revocation

JWTs use ES256 with `iss=MIKKA_CLOUD_URL`, `aud=mikka-cloud`, `sub`, `srv`
(server), `wsp` (billing workspace), `mode`, `cid` (grant/key), `ver`,
`scope`, `iat`, `exp`, `jti`. Clients treat the token as opaque. The JWKS
endpoint is `/.well-known/jwks.json`; keys rotate every 90 days and remain
available for verification for 24 hours after rotation.

`POST /oauth/revoke` is form encoded: `client_id`, `client_secret`, `token`,
optional `token_type_hint`. Unknown tokens return 200 `{}`. A personal refresh
token revokes the family. Supplying a server key as both `client_secret` and
`token` revokes that whole key and its issued access tokens. Revoking only an
access token revokes its `jti`.

`POST /v1/servers/revoke` accepts the registration `client_id` and
`client_secret` as a form. It revokes the server's grants and keys and queues
revocation of issued native GitHub installation tokens.

**Multi-instance correction to the design:** JWT signature verification is
local. Capability execution also checks the current grant/key/server state in
the cloud service's database operation. An in-memory set plus live messages
alone cannot guarantee immediate revocation after cold starts, disconnects or
missed messages. Authoritative checks fail closed and add no separate remote
authentication service or introspection HTTP hop. Provider traffic from the
execution machine remains direct.

## GitHub and webhook contract

`POST /v1/github/installation-token` accepts `installationId`, optional
`repositories` and narrowed `permissions`, and returns a real GitHub
installation token and expiry. The cloud checks installation ownership and
server binding. The machine receives this token during preparation and talks
directly to GitHub. Renewal happens through its credential mechanism.

After checking the original GitHub signature, the cloud forwards the original
body to `<origin><basePath>/api/cloud/webhooks/github` with:

```text
Mikka-Cloud-Signature: t=<Unix seconds>,v1=<lowercase hex HMAC>
x-github-delivery: <original delivery ID>
x-github-event: <original event>
```

The HMAC is SHA-256 under `serverSecret` over the exact UTF-8 bytes
`timestamp + "." + body`. The receiver accepts only a five-minute window,
constant-time compares the MAC and deduplicates delivery IDs. Redirects are
not followed. Forwarding targets must pass public-address/SSRF checks at
connection time. Failures use bounded exponential redelivery for up to 24
hours. Neither payload content nor credentials are logged.

## Errors

Cloud endpoints return `{ "error": "<OAuth or cloud code>", "code":
"<stable cloud code>" }`; clients use `code`. Public local routes return the
stable code as `error`. No provider response body, token, email or free-text
exception is returned.

| Code | Meaning |
| --- | --- |
| `cloud_not_connected` | No usable connection |
| `cloud_scope_missing` | Binding does not authorize this capability |
| `cloud_server_revoked` | Server, key, grant or token was revoked |
| `cloud_invalid_request` | Invalid address, callback, state or protocol |
| `cloud_rate_limited` | Per-server or per-person limit |
| `cloud_access_denied` | Current identity cannot perform the operation |
| `cloud_unavailable` | Transport, storage or upstream failure |
| `cloud_quota_exhausted` | Credit balance or team monthly limit |

All public codes have `RunErrors.*` copy in English and Chinese. Causes remain
available to diagnostics by name and code only. Local stored registration,
server-key and token material uses the existing AES-GCM `sealSecret` format
under `WORKSPACE_SECRETS_KEY`, with distinct server/user-bound associated data.
