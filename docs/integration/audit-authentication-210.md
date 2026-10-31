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
historical fixtures were retained. Setup log: `/tmp/mikka-auth-audit210-setup.log`. The current combined test
log `/tmp/mikka-auth-audit210-db.log` covers both producer changes below; it
replaces the earlier auth-only log and is not a retained raw log of `d4055907`.

The actual Better Auth handler, API dispatcher and installed nextCookies plugin
passed its five tests within the combined 8/8 run, zero skipped: correct actors/current workspace scope, unknown
account parity, exact session IDs and metadata privacy, actual sink failure and
relay recovery, source failure with HTTP503/no response cookie or token/no new
Next cookie-store write/session revocation, and unchanged actual account-pool
fingerprint restoration after pending and delivered login cleanup. Only Next's
request cookie-store is an explicit fixture port. The fingerprint check uses
real pool owned-row traversal; it does not claim a full leased-browser execution.
No OAuth provider, SaaS write or real production login was invoked.


## Credential and Agent approval transitions

The remaining ordinary #210 source gaps were credential save/replace/revoke and
Agent approval decision/consumption (occurrence8 × impact6 = 48 for missing
records of these normal security operations). Both now use the existing main
DB transaction-bound audit writer; an audit failure rolls back the protected
transition. Repeated revocation or approval consumption creates no false event.

Credential events contain only the opaque credential ID and empty metadata.
The request-authenticated user/PAT supplies the actor; internal callers without
that context remain system actors. No site, username, password or encrypted
payload is recorded. Human approval decisions take the cookie-authenticated
principal from the existing route. A device consuming approval is a system
actor identified by its device ID, rather than a claimed human action. Both the
Bot and task workspaces receive the same approval ID, run ID, decision (when
applicable) and policy revision; tool input is excluded. Current membership,
run ownership, lease and policy checks remain in the existing transaction guard.
The five actions also have ordinary English and Chinese audit sentences.

The same tracked, fully prepared isolated PG target passed 8/8 combined tests,
zero skipped: the five authentication tests above plus the lifecycle parent and
its two subtests. Real credential create/replace/revoke, peer rejection, actual
user/token actors, both Bot/task workspace records, approve/deny, ten concurrent
consume attempts yielding one permit, and audit-write rejection/atomic rollback
were exercised. The KMS envelope generator and authenticated caller are explicit
fixture ports; this is a business/database proof, not a live-provider run.
New disposable lifecycle fixtures are retained on that target; historical DBs,
account baselines and quarantine evidence are unchanged.

Source verification also passed the complete credential unit scripts, audit
contracts/routes, DB-runner inventory, typecheck and i18n/copy checks. Existing
credential DB fixtures now load the tracked audit-table migration, matching the
new transaction dependency; the required CI inventory includes both new tests.
Real OAuth/model/SaaS and end-to-end provider fault-matrix acceptance remain
unexecuted according to the owner's instructions and belong to #181. No new
retention UI, legal retention period, SIEM platform or future event catalogue is
introduced by this closeout.


## Isolated credential-broker runtime

PR #660's `isolation` job124598591122 exposed a real packaging regression: the
CredentialStore's new audit import pulled the app-only `record.ts` facade and
its default database into the broker, causing esbuild's `server-only` resolution
failure. The shared transaction writer now lives in `lib/audit/write.ts` with
only the audit schema/events and a type-only Drizzle executor dependency.
`record.ts` retains its existing exports, default-database helper and server
boundary; CredentialStore and AgentToolApprovalStore use the shared writer.
Every original transaction audit remains mandatory. No marker shim, external
exception, guard or CI skip was introduced.

The existing broker build's exact entry points and options were exercised with
`write:false` and `metafile:true`: `fill.js` and `oidc.js` both bundled,
393 inputs / 2,970,748 output bytes, zero `server-only` or app DB index inputs.
Existing dist/public artifacts were untouched. Log:
`/tmp/mikka-audit210-broker-build.log`. The ordinary credential scripts also
pass without the newly added app-only test loader, which has been removed.


The broker CI performs an independent `npm ci --workspaces=false --prefix
services/credential-broker` before that build. Its own manifest and npm lock
therefore explicitly include the root's existing `drizzle-orm` constraint
`^0.45.4`, pinned to0.45.4. The lock was resolved with package-lock-only,
without installing packages; the root pnpm lock is unchanged. This declaration
closes the service-only installation dependency rather than relying on the
root installation being present. A fresh independent install was not performed
locally; the broker CI remains the final installation gate.


## Settings saved-login deletion caller

PR #660 PG shard1 exposed a production caller still passing `workspaceId:''`
from `deleteSavedLoginFor`; mandatory audit validation therefore refused every
normal settings deletion (occurrence10 × impact6 = 60). The existing server
action now obtains the full cookie-authenticated user and calls the existing
current-workspace loader. Its validated membership/cookie context and actual
user actor flow into the owner-scoped vault removal. The credential owner check,
owner-wide revocation and existing lease/session invalidation are unchanged;
no client-supplied workspace or actor is trusted and auditing is not bypassed.

The existing real PG `settings-activity.db.test.ts` suite passed5/5, zero skipped,
on the same fully migrated isolated target. It now initializes a real current
workspace/member and asserts that deletion emits exactly the expected current
workspace/user/opaque credential reference with empty metadata, while retaining
peer refusal, invalid-ID refusal, session requirements and outstanding-lease
invalidation checks. Session/request and request locale are explicit ports;
the workspace loader, protected actions and database remain real. Log:
`/tmp/mikka-audit210-settings-pg.log`. Typecheck, focused lint and diff checks pass.
