# Authentication email and recovery

This backend candidate preserves the existing account. It does not delete or recreate users, mark existing email addresses verified, reset a real password, or relax Google account linking.

## Provider and configuration

Use the existing Resend service and fixed sender `Mikka <noreply@aspectlylabs.com>`. A read-only Resend metadata check on 2026-10-25 confirmed `aspectlylabs.com` is verified, sending enabled, and click tracking disabled. No DNS, domain, API-key or account changes were made. Neither this candidate nor main `7251bf2` contained a prior Resend transport.

The application requires a server-only `RESEND_API_KEY` and its existing exact `BETTER_AUTH_URL`/database configuration. Read-only Infisical metadata checks found no mail configuration under dev/staging/prod `/vercel`, `/`, or existing `/platform` scopes and no mail-named root folders. This is bounded evidence, not proof that a key does not exist in another service. No secret value was read. A connected Resend tool is not an application runtime credential. Reusing/configuring a suitable existing server key in the independent nonproduction environment requires the outstanding specific configuration approval; do not create a new key or copy a tool credential.

## Backend contract

`lib/auth-email.ts` connects the actual Better Auth 1.7.12 callbacks. Ordinary signup keeps its existing session behavior and sends verification in the background. Global password-login verification requirements are unchanged. Verification never automatically signs the user in; after verification, normal Google login can apply the existing local-email-verified account-linking policy.

- `POST /mikka/api/auth/send-verification-email` requests verification for an eligible address. The only completion destination is this deployment's `/mikka/sign-in`.
- `GET /mikka/api/auth/verify-email` uses Better Auth's signed, 15-minute token plus a random nonce. Only the token/nonce digest and intended user ID/email are persisted in the existing verification table. The application validates destination, signature/expiry and issuance, then atomically consumes the issuance record before the library updates verification. A request-scoped adapter keeps the library's subsequent lookup/write bound to the immutable issuance user ID while preserving its hooks and cache handling. Concurrent replay and reuse against a recreated same-email user fail closed, including replacement after issuance consumption. A failure after consumption requires a new email; no old token is resurrected. Email-change flows are not enabled and are not accepted by this verifier; enabling that feature later requires reviewing concurrent email-change semantics.
- `POST /mikka/api/auth/request-password-reset` requests a standard Better Auth 15-minute reset link. Its fixed destination is this deployment's `/mikka/reset-password`.
- `POST /mikka/api/auth/reset-password` retains the library's atomic password update/single-use consumption transaction and revokes all existing sessions. Existing Better Auth behavior allowing a mailbox-proven reset to add a credential to an OAuth-only account is retained; this is not password disclosure.

Manual request endpoints return HTTP 202 with `delivery: "unconfirmed"` for eligible, absent, already-verified and provider-failure cases. This is not a delivery receipt or a retry promise. Transport outcomes are separately classified as `accepted_by_provider`, `failed`, or `throttled`; default failure logging contains only a fixed event and message kind. Resend acceptance is not inbox delivery. No recipient, link, token, provider body, key or underlying exception is logged. A globally missing runtime key fails requests uniformly before account lookup.

External mail I/O runs using the project's existing Next `after` pattern, so a recipient-dependent network request does not delay the public response. A minimum response floor also covers local lookup differences. The implementation does not introduce a durable mail queue or promise automatic delivery retries. Users may request a new email after the rate window; operational failure monitoring is still needed.

Link-consumption endpoints require the exact fixed completion URL; omitted, empty and `/` aliases are rejected rather than forwarded to the library. Verification and recovery responses set `no-store` and `no-referrer`. As with standard emailed bearer links, infrastructure access-log policies must also avoid retaining link parameters; the application never logs them.

The sender atomically reserves a per-recipient, per-kind minute bucket in the existing verification store, covering both automatic and manual sends across application instances. The library's request/IP limits are explicitly enabled. Deployment proxy headers must retain the existing trusted ingress boundary; the per-recipient gate does not depend on caller-supplied IP headers. Verification and rate markers expire and use Better Auth's existing verification cleanup mechanism. No new database migration is required.

## Interaction and acceptance gaps

No frontend was modified. Existing authentication pages lack a verification-resend action, a recovery request action and a new-password submission page. The minimal follow-up interaction is: request email with a generic non-enumerating notice; open the secure email link; for password recovery only, enter/confirm a new password and POST the standard reset endpoint. The reset destination must exist before sending real recovery mail. Passwords and email links must never be pasted into assistant chat.

Linux acceptance uses `node scripts/test-auth-email.mjs`: disposable loopback PostgreSQL, Better Auth's real migrations/endpoints, synthetic users/passwords and a mocked Resend HTTPS boundary. It never reads application credentials or sends mail. The local test deletes only users it created in its disposable database to check old-token/recreated-user isolation.

Real verification proposal, not executed: deploy an independently approved nonproduction candidate using dev-local `br-plain-hat-b58lsr0c/mikka`, configure only its server mail key, send one verification email to `alexjiang20232024@gmail.com`, then have the user open its private link and verify the existing Mikka account normally. Confirm through the application that Google login returns to the same Preview and creates a genuine session. Retain the 612 Claude grant. No real password-reset request, reset-link consumption or password change is part of that verification action. Deployment/configuration approval remains a separate gate; production is untouched.
