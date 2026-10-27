# Account credential backend (#180)

This implements Alex's 2026-10-27 updates to #180 and the rules merged in #343.
The active design uses AWS KMS immediately. The Infisical vault/master-key
proposal in the design's historical section is superseded.

## Deployment and identity

The Next application runs in Vercel project `mikka`; the standalone Node APIs
in `services/credential-broker` run in `mikka-credential-broker` with that root
directory and access to source files outside it. Both use Team OIDC. The app
can GenerateDataKey/Encrypt; the broker can Decrypt. There is no static AWS
key or fallback credential chain. The broker verifies the app's exact signed
project/team/environment identity before consuming an opaque, database-bound
30-second single-use lease. Both deployments must use the same isolated
Preview database and source commit when testing together.

Infisical supplies the five AWS settings from `staging:/aws` for Preview and
`prod:/aws` for Production. Runtime settings are `CREDENTIAL_VAULT_ENABLED=1`,
`CREDENTIAL_BROKER_URL` (a frozen deployment origin) and, for protected
Previews, `CREDENTIAL_BROKER_PREVIEW_BYPASS`. Store settings in Infisical and
scope delivery to the selected environment/branch. Never enable the vault
before its explicit migration has been applied to the matching database.

## Data and authorization

The additive migration creates `credentials`, `credential_secrets`,
`browser_sessions`, `credential_access_events`, `credential_challenges` and
`credential_fill_leases`. Metadata belongs to a user account. Ciphertexts and
wrapped DEKs live in Neon. KMS encryption context is exactly
`{userId, credentialId, origin}`; AES-GCM AAD additionally binds the version and
purpose (password, session or OTP). A fresh random nonce is used for every
write. Cookie/localStorage snapshots reuse the credential's DEK with separate
purpose AAD, so the decrypt-only broker needs no GenerateDataKey permission.

The server derives the user from an authenticated owner-bound bot/subagent or
thread; workspace membership alone never authorizes a login. No API or model
tool accepts or returns a credential ID. Multiple matching accounts require a
new login choice instead of silently selecting one. Deletion revokes first,
erases password/session ciphertexts and outstanding leases atomically, and
serializes with an in-flight fill through an account/origin database lock.

## API contract

The subagent prefix is `/api/bots/:botId/subagents/:id/credentials`; the thread
prefix is `/api/threads/:runId/credentials`.

- `POST <prefix>/challenge` with `{site}` issues a five-minute one-use form nonce.
- `POST <prefix>` accepts `{nonce,origin,username,password}` or
  `{nonce,origin,code}`. Codes are encrypted, used once and never saved as a
  reusable login. The consumed lease's OTP ciphertext is erased immediately.
- `POST <prefix>/login` with `{site}` attempts account-scoped session reuse,
  then password filling. Responses contain only status and origin.
- `GET /api/credentials` returns owner-only login metadata without IDs.
- `DELETE /api/credentials` with `{origin,username}` revokes the saved login.
- `POST /v1/devices/:deviceId/runs/:runId/credentials/login` is the coding
  runtime entry point; device/run/user/workspace are all server-checked.

Cookie-authenticated mutations require exact Origin, `X-Mikka-Credential: 1`,
JSON and a streamed 12 KiB maximum. Schemas reject unknown fields, including
caller-selected user IDs, credential IDs and leases. Password fields reject
CR/LF/NUL. Responses and errors are no-store and provider errors have no cause.

## Browser integration (#342)

`resolveSubagentBrowserTarget` and `resolveThreadBrowserTarget` are the only
integration seams. This PR's implementation fails closed until #342 supplies
the actual owner-bound gateway. Its result contains targetId, exact origin,
an HTTPS E2B endpoint with a broker-only capability and expiresAt in millis.
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

HMAC fingerprints (using a domain-separated derivation of the existing auth
secret) reject copies of saved passwords before coordinator inbox and chat/tool
messages are persisted. Request logging already records only route templates,
status and hashed identity, never bodies. This detects saved passwords; it is
not a general classifier for previously unknown text someone types in chat.

The authenticated daily cleanup cron removes expired/consumed challenges,
leases and session ciphertexts; failed deletes return failure and retry on the
next invocation. Logical revocation/expiry is checked independently of cleanup.

## Verification

`test:credentials` exercises context/AAD isolation, tampering, exact origins,
CSRF, body limits, field restrictions, screenshot gating, HMAC and OTP purpose.
`test:credentials-db` runs only on an explicitly isolated PostgreSQL database
and checks same-workspace owner isolation, workspace changes, one-use forms and
leases, code erasure, expiry and revocation. It is enrolled in the required CI
database inventory as well as the dedicated credential workflow.

The protected Preview-only `/api/credentials/oidc` probe calls the broker using
the app's signed OIDC token. It reports only own-role/cross-role booleans and
real KMS same-context/wrong-owner results. It returns no OIDC or STS credentials.
Runtime evidence and frozen deployment SHAs are recorded in the PR/issue.
Frontend pill/card/settings acceptance is intentionally pending the separately
approved Figma work; neither this PR nor a passing unit test closes #180.
