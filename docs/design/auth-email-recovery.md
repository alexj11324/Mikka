# Authentication email and recovery

This backend candidate preserves the existing account. It does not delete or recreate users, mark existing email addresses verified, reset a real password, or relax Google account linking.

## Provider and configuration

The server sends through Resend using the application's fixed, verified sender. Configure `RESEND_API_KEY` only on the server and keep production and nonproduction credentials separate. The existing exact `BETTER_AUTH_URL` and database configuration determine the account environment and completion origin. A tool's credential is not an application runtime credential.

## Backend contract

`lib/auth-email.ts` connects the actual Better Auth 1.7.12 callbacks. Ordinary signup keeps its existing session behavior and sends verification in the background. Global password-login verification requirements are unchanged. Verification never automatically signs the user in; after verification, normal Google login can apply the existing local-email-verified account-linking policy.

- `POST /mikka/api/auth/send-verification-email` requests verification for an eligible address. The only completion destination is this deployment's `/mikka/sign-in`.
- `GET /mikka/api/auth/verify-email` uses Better Auth's signed, 15-minute token plus a random nonce. Only the token/nonce digest and intended user ID/email are persisted in the existing verification table. The application validates destination, signature/expiry and issuance, then atomically consumes the issuance record with the library's user update. A request-scoped adapter keeps the library's subsequent lookup/write bound to the immutable issuance user ID while preserving its hooks and cache handling. Concurrent replay and reuse against a recreated same-email user fail closed, including replacement after issuance consumption. A database update failure rolls back consumption so the same unexpired link can be retried. Email-change flows are not enabled and are not accepted by this verifier; enabling that feature later requires reviewing concurrent email-change semantics.
- `POST /mikka/api/auth/request-password-reset` requests a standard Better Auth 15-minute reset link. Its fixed destination is this deployment's `/mikka/reset-password`.
- `POST /mikka/api/auth/reset-password` retains the library's atomic password update/single-use consumption transaction and revokes all existing sessions. Existing Better Auth behavior allowing a mailbox-proven reset to add a credential to an OAuth-only account is retained; this is not password disclosure.

Manual request endpoints return HTTP 202 with `delivery: "unconfirmed"` for eligible, absent, already-verified and provider-failure cases. This is not a delivery receipt or a retry promise. Transport outcomes are separately classified as `accepted_by_provider`, `failed`, or `throttled`; default failure logging contains only a fixed event and message kind. Resend acceptance is not inbox delivery. No recipient, link, token, provider body, key or underlying exception is logged. A globally missing runtime key fails requests uniformly before account lookup.

External mail I/O runs using the project's existing Next `after` pattern, so a recipient-dependent network request does not delay the public response. A minimum response floor also covers local lookup differences. The implementation does not introduce a durable mail queue or promise automatic delivery retries. Users may request a new email after the rate window; operational failure monitoring is still needed.

Link-consumption endpoints require the exact fixed completion URL; omitted, empty and `/` aliases are rejected rather than forwarded to the library. Verification and recovery responses set `no-store` and `no-referrer`. As with standard emailed bearer links, infrastructure access-log policies must also avoid retaining link parameters; the application never logs them.

The sender atomically reserves a per-recipient, per-kind minute bucket in the existing verification store, covering both automatic and manual sends across application instances. The library's request/IP limits are explicitly enabled. Deployment proxy headers must retain the existing trusted ingress boundary; the per-recipient gate does not depend on caller-supplied IP headers. Verification and rate markers expire and use Better Auth's existing verification cleanup mechanism. No new database migration is required.

## Interaction and acceptance gaps

The recovery UI uses the existing authentication shell and localization. Email requests show a generic non-enumerating notice. The reset form removes the token from the address bar before interaction, keeps it in component memory, and submits the password only to the same-origin reset endpoint. Passwords and email links must never enter assistant chat or telemetry.

Linux acceptance uses `node scripts/test-auth-email.mjs`: disposable loopback PostgreSQL, Better Auth's real migrations/endpoints, synthetic users/passwords and a mocked Resend HTTPS boundary. It never reads application credentials or sends mail. The local test deletes only users it created in its disposable database to check old-token/recreated-user isolation.

Production acceptance must target the deployed application's canonical origin and actual account environment. Verify provider delivery separately from email-link consumption and a genuine authenticated session. Do not substitute a test-environment account for the production account. Record only sanitized deployment and result metadata; never publish raw mail links, credentials, personal account metadata, or private infrastructure details.

Verification retry boundary: nonce consumption and the immutable-owner database update now share Better Auth's PostgreSQL transaction. A rejected/failed update rolls back both; database after-commit hooks retain Better Auth's normal post-commit behavior. Rejected verification logs only a fixed stage label, never the URL, token, nonce, email, or signature key. HEAD inspection does not verify; an ordinary successful GET verifies and consumes once. This does not make GET-prefetching email scanners harmless, and diagnostics must not assume that a scanner caused a failure.
