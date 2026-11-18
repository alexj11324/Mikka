# Account credential backend (#180)

This implements Alex's 2026-10-27 updates to #180 and the rules merged in #343.
Cloud deployments use AWS KMS. Community deployments use the separately
implemented `CREDENTIAL_MASTER_KEY` backend and an in-process broker.
`credentialKms()` in `lib/credentials/kms.ts` selects by edition. See
[self-hosted services](../self-hosting-byok.md). The original Infisical
vault/master-key proposal remains superseded.

## Deployment and identity

The Cloudflare API ingress binds the app to the private Cloudflare credential
broker and credential-identity service. The ingress forwards only the private
broker routes; the broker accepts calls only on that private transport and
requires the Cloudflare workload identity. The app can GenerateDataKey/Encrypt;
the broker can Decrypt. There is no public broker endpoint, static AWS key, or
Vercel OIDC fallback. The gateway's Cloudflare broker/identity implementation
is part of this path and must be deployed with the matching app release.

The app and broker use the same source revision and database. Infisical supplies
the five AWS settings from `staging:/aws` for staging and `prod:/aws` for
production. The vault is enabled by default; `CREDENTIAL_VAULT_ENABLED=0` is an
incident kill switch. Cloudflare service bindings provide the private broker
and identity endpoints; do not configure a public `CREDENTIAL_BROKER_URL` or
preview bypass. Apply the credential migration to the matching database before
serving the feature.

## Data and authorization

The additive migration creates `credentials`, `credential_secrets`,
`browser_sessions`, `credential_access_events`, `credential_challenges` and
`credential_fill_leases`. Metadata belongs to a user account. Ciphertexts and
wrapped DEKs live in Neon. KMS encryption context is exactly
`{userId, credentialId, origin}`; AES-GCM AAD additionally binds the version and
purpose (password, session or OTP). A fresh random nonce is used for every
write. Cookie/localStorage snapshots reuse the credential's DEK with separate
purpose AAD, so the decrypt-only broker needs no GenerateDataKey permission.
The snapshot includes cookies returned by Chrome for the credential origin,
including both HttpOnly and script-accessible cookies, and that origin's localStorage.
Snapshots recorded after submission are unverified candidates, not proof that
the website accepted a login; a later visual observation must make that decision.

The server derives the user from an authenticated owner-bound bot/subagent or
thread; workspace membership alone never authorizes a login. No API or model
tool accepts or returns a credential ID. Multiple matching accounts require a
new login choice instead of silently selecting one. While retention is in
effect, revocation marks the login revoked, expires its saved session and
consumes outstanding leases without deleting their records. Revocation
serializes with an in-flight fill through an account/origin database lock.
It does not log out an already running browser or revoke sessions at the
third-party website. Updating a saved login expires its retained session; broker
leases bind the encrypted secret nonce, checked under the account lock before I/O.

## API contract

The subagent prefix is `/api/bots/:botId/subagents/:id/credentials`; the thread
prefix is `/api/threads/:runId/credentials`.

- `POST <prefix>/challenge` with `{site}` issues a five-minute one-use form nonce.
- `POST <prefix>` accepts `{nonce,origin,username,password}` or
  `{nonce,origin,code}`. Codes are encrypted, used once and never saved as a
  reusable login. The consumed lease's OTP ciphertext is erased immediately.
- `POST <prefix>/login` with `{site}` applies a saved session when present or
  inserts an observed login field under the viewing guard. `{site,forcePassword:true}` selects a password
  retry after the caller has visually assessed the session result. Responses
  contain only origin and the mechanical result `session_applied` or
  `guarded` (or `needs_login` if there is no unambiguous saved login).
  None means the website accepted a login. After the viewing guard has ended,
  the visual workflow must inspect the redacted page and decide whether login
  succeeded, a password retry or a verification code is needed. It must not
  observe the page while the guard is active or expose credential material.
- `GET /api/credentials` returns owner-only login metadata without IDs.
- `DELETE /api/credentials` with `{origin,username}` revokes the saved login and returns `{status:'revoked'}`; it retains the saved records.
- `POST /v1/devices/:deviceId/runs/:runId/credentials/login` is the coding
  runtime entry point with the same `site` and optional `forcePassword` body;
  device/run/user/workspace are all server-checked.

Cookie-authenticated mutations require exact Origin, `X-Mikka-Credential: 1`,
JSON and a streamed 12 KiB maximum. Schemas reject unknown fields, including
caller-selected user IDs, credential IDs and leases. Password fields reject
CR/LF/NUL. Responses and errors are no-store and provider errors have no cause.

## Browser integration (#342)

`resolveSubagentBrowserTarget` and `resolveThreadBrowserTarget` in
`lib/cloud-computer/subagent-browser.ts` resolve the owner-bound gateway. Their
results contain targetId, exact origin, an HTTPS E2B endpoint with a broker-only
capability and expiresAt in milliseconds. The subagent resolver also supplies
observed input bindings used by the credential review path.
The broker appends `/credentials/begin` to the URL path, preserving its query.
Begin atomically blocks viewing, screenshots, model DOM reads and other input;
it returns a guarded CDP websocket and token. The broker attaches to the exact
target, checks top-frame origin before each insertion and uses Input.insertText.
Browsing is unrestricted; secret insertion requires exact HTTPS origin after
IDNA normalization and forbids URL userinfo and cross-origin iframes.

Viewing resumes only after sensitive inputs are empty and the gateway's own
document/input checks pass. A URL hash/pushState change does not authorize it.
Errors, worker crashes and timeouts keep the guard closed. CDP parameters,
responses, cookies, localStorage and Input arguments must never be logged.
The model receives no secret, credential ID, cookie or broker capability.

### Current integration boundary

The broker accepts `observedInputs` (and the legacy singular `observedInput`),
with `{loaderId,backendNodeId,credentialRole,epoch,permissionVersion}` for each
field. The subagent resolver obtains these from `/credentials/observe` and
checks the current target, origin and workspace policy.
`lib/cloud-computer/credential-reviews.ts` binds and consumes the credential
operation before issuing its scoped continuation capability. These fields
come from the trusted host and remain outside the credential HTTP submission
body. The store additionally binds each lease to the encrypted
secret's nonce; the broker verifies it under the account lock before gateway
I/O, fencing password updates even after a lease has been claimed.

`guarded` means insertion completed with observation still locked. The gateway
retains the guard and keeps its token private. The subagent credential review
path implements authorized submit/clear continuation through
`/credentials/continue`, checks its `resumed` result and requests visual
observation after a safe release. Saved-login consent and secret revision are
rechecked before the operation. The thread resolver has no observed-input
binding. `login()` requires a subagent and `observedInputs`, so that thread
login path remains unavailable. Source wiring and the unit/database/CDP
fixtures require separate runtime acceptance of the browser flow.

HMAC fingerprints (using a domain-separated derivation of the existing auth
secret) reject copies of saved passwords before coordinator inbox and chat/tool
messages are persisted. Request logging already records only route templates,
status and hashed identity, never bodies. This detects saved passwords; it is
not a general classifier for previously unknown text someone types in chat.

The authenticated daily cleanup cron removes expired/consumed challenges,
leases and session ciphertexts; failed deletes return failure and retry on the
next invocation. Logical revocation/expiry is checked independently of cleanup.

## Enablement

Enabled by default, with the existing authentication, owner, target and KMS
checks. `CREDENTIAL_VAULT_ENABLED=0` retains the incident `503` path. Default
availability does not supply missing KMS configuration or provider authority.

1. Apply the credential migration to the target database.
2. Confirm the matching AWS values are synced from Infisical to the Cloudflare
   app and private broker services.
3. Confirm the API ingress has its private broker and identity bindings, then
   verify an authorized browser credential flow against that exact release.
4. Record the matching runtime verification. An explicit incident kill switch
   restores the `503` path; saved ciphertext rows remain.

## Verification

`test:credentials` exercises context/AAD isolation, tampering, exact origins,
CSRF, body limits, field restrictions, screenshot gating, HMAC and OTP purpose.
`test:credentials-db` runs only on an explicitly isolated PostgreSQL database
and checks same-workspace owner isolation, workspace changes, one-use forms and
leases, code erasure, expiry and revocation. It is enrolled in the required CI
database inventory as well as the dedicated credential workflow.

Private runtime acceptance exercises the Cloudflare identity and broker binding,
role separation, and KMS same-context/wrong-owner behavior. Runtime evidence and
frozen deployment SHAs are recorded with the release.
The original backend handoff left frontend pill/card/settings acceptance to
the separately approved Figma work. Settings login creation and password
replacement are implemented in `app/actions/settings-activity.ts`; their
contract is in [settings activity](../settings-backend/activity.md). Acceptance
for a later revision follows the current acceptance guide.
