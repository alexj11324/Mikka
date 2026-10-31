# Authentication audit delivery (#210)

Base main `78eb5523f48859f83ee271eb5dc9f035044a353b`. The existing
`auth.signed_in` and `auth.sign_in_failed` catalogue entries had no production
writers. Ordinary password sign-ins and refusals therefore produced no tenant
security audit. This is an observed source gap, occurrence8 × impact6 = 48,
not a hypothetical authentication mechanism.

The existing Better Auth after hook now queues these events in the existing
workspace audit outbox. Successful password/OAuth sign-ins take their identity
only from the newly issued server session. Failed password sign-ins resolve a
known attempted account internally, use a system actor and identify that account
only as the target. Body-supplied owner/workspace fields are never authority.
Unknown accounts and anonymous OAuth failures have no verified tenant, so they
create no invented workspace event. Suspended memberships receive no event.
No password, bearer, cookie, submitted email, URL or raw exception is recorded.
A successful event references the non-secret session ID. The optional existing
`newDevice` field is omitted because a new session is not proof of a new device.

Membership rows remain locked through the outbox commit. Sink outages retain
intent for the existing relay. If intent cannot commit, successful sign-in
withholds all new Set-Cookie headers, clears the pending session, attempts its
revocation and returns `AUTH_AUDIT_UNAVAILABLE`/503 rather than a token. A failed
sign-in stays refused with the original response; unavailable audit records only
a fixed diagnostic, preserving unknown-account parity. Ordinary session reads
create no sign-in events.

The automatic account helper cleans only disposable successful-login audit rows
for the exact session resources already registered by its current exclusive
lease, after revoking those sessions. Actor, target, action and positive IDs
restrict deletion. Failure/business audit, other sessions, original baselines,
quarantine and retained lease evidence remain unchanged. The helper locks queued
intent before inspecting the sink, so the relay cannot publish after cleanup.

Cloud Linux verification used the new disposable
`mikka_auth_audit210_e2e` on the existing PG17/loopback55599 container, prepared
with the normal tracked main/workspace setup. Old databases, ledgers and
historical fixtures were retained. Setup/test logs:
`/tmp/mikka-auth-audit210-{setup,db}.log`.

The actual Better Auth handler, API dispatcher and installed nextCookies plugin
passed 5/5 tests, zero skipped: correct actors/current workspace scope, unknown
account parity, exact session IDs and metadata privacy, actual sink failure and
relay recovery, source failure with HTTP503/no response cookie or token/no new
Next cookie-store write/session revocation, and unchanged actual account-pool
fingerprint restoration after pending and delivered login cleanup. Only Next's
request cookie-store is an explicit fixture port. The fingerprint check uses
real pool owned-row traversal; it does not claim a full leased-browser execution.
No OAuth provider, SaaS write or real production login was invoked.
