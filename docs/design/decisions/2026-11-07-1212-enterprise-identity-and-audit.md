# Enterprise v1: identity, organization governance and audit

Issue: [#1608](https://github.com/alexj11324/Mikka/issues/1608). Knowledge bases and RAG remain out of scope.

## Identity and dependency decision

Better Auth remains the account/session authority. Mikka's existing `mikka_workspace_members` remains the only Workspace membership authority. `mikka_organization_members` grants administrative control of an Organization; it does not grant access to a Workspace, Task, Factory item, Artifact, MCP source or borrowed model credential. Enterprise is a governance layer over Shared Workspaces, not a third Workspace type.

The reviewed published versions are `better-auth@1.7.12`, `@better-auth/core@1.7.12`, `@better-auth/sso@1.7.12` and `@better-auth/scim@1.7.12`:

| Package | Published license | Compatibility contract | Use here |
| --- | --- | --- | --- |
| [`@better-auth/sso@1.7.12`](https://unpkg.com/@better-auth/sso@1.7.12/package.json) | MIT | `better-auth` / `@better-auth/core` `^1.7.12`, `better-call` `1.4.4` | Native OIDC/SAML verification, state, PKCE and replay handling |
| [`@better-auth/scim@1.7.12`](https://unpkg.com/@better-auth/scim@1.7.12/package.json) | MIT | `better-auth` / `@better-auth/core` `^1.7.12`, `better-call` `1.4.4` | Evaluated; not installed |

The pinned SSO package's `resolveUser` receives `SSOUserResolutionContext.database: DBTransactionAdapter`. User resolution, account finalization and session creation share the native authentication transaction. Mikka uses native `consumeOne` for one-time linking consent and `incrementOne` for directory/connection fences. This is not an after-login hook that might grant access before validation finishes.

Authentication hooks receive a route template in `ctx.path` and the actual provider in `ctx.params`. Session assurance fields are deliberately `returned: false`; sign-out auditing reads them from the authenticated session row before native deletion. Successful SSO synchronization and its Organization audit finish before a bearer cookie can leave the handler. Failure removes the cookie and attempts to delete the unpublished session.

Native SAML Single Logout verifies signed incoming LogoutRequest/LogoutResponse messages. Mikka does not let a callback's browser cookie select or clear an unrelated session: only the native-verified provider/NameID/SessionIndex selects the recorded SAML login family. SP-initiated logout requires the current trusted session to belong to that provider and deletes the initiating session before leaving the application.

OIDC [RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html) uses `POST /api/auth/sso/oidc/logout/:providerId`. The backend proves the exact current session/provider/Organization in the Auth database, deletes only that local session through Better Auth, and clears the native session cookies before preparing an upstream request. One native-validated discovery snapshot supplies both login endpoints and optional `end_session_endpoint`; the native hydrated SSO config otherwise drops the latter. The encrypted provider config retains it as `endSessionEndpoint`. An absent endpoint returns `upstream: not_supported` and an unavailable provider/nonce store returns `upstream: unavailable`, both with `localSessionRevoked: true` and a fixed sign-in destination. There is no guessed logout URL and no attempt to restore a session after an upstream error.

The OP request carries `client_id`, a server-fixed `post_logout_redirect_uri`, and opaque `state`; it does not carry `id_token_hint`, a client secret, or user-provided redirect parameters. Existing account hooks continue discarding ID tokens. The standard permits this client-ID path and requires the OP to confirm logout with the user when no ID token hint is supplied. Administrators must register the returned `postLogoutRedirectURI` exactly in the OP's logout redirect allowlist, separately from the login callback. A start response saying `upstream: requested` and a subsequent callback record are not cryptographic claims that every upstream session ended.

The callback is `GET /api/auth/sso/oidc/logout/callback/:providerId`. A five-minute native verification record binds a hashed state to the original user/session, Organization/provider, issuer/client, configuration revision and fixed callback. A separate signed, HttpOnly, SameSite=Lax browser verifier is checked before atomic native consumption, so missing or wrong-browser cookies and wrong-provider callbacks cannot consume the original intent. The callback clears only its own verifier cookie and redirects to the fixed sign-in page. It never authenticates a user or deletes whichever session happens to be current on return. Invalid, expired, concurrent or replayed callbacks cannot close a subsequent login. Audits distinguish local-only, upstream-requested, upstream-returned and upstream-failed outcomes without retaining tokens, verifier values or provider error descriptions.

The pinned SSO package needs a narrow, reviewable [pnpm patch](../../../patches/@better-auth__sso@1.7.12.patch) for its current Samlify contract: forward outbound logout-signing policy, pass RelayState in the supported argument, supply the original Redirect-binding signature octets, and replace the warn-only LogoutResponse correlation with native atomic `consumeVerificationValue`. A signed response requires an existing, unexpired request for the same provider; concurrent replay has a single winner. Invalid signatures cannot consume the pending request. Incoming LogoutRequest verification also connects Samlify's issuer/request-ID replay cache to native atomic `reserveVerificationValue`, namespaced by provider. The library verifies the signature, destination and expiry before reserving a request; an old signed logout cannot terminate a later session. Signature generation, XML verification, signature/message consistency and atomic verification storage remain library implementations. Any dependency update must repeat these protocol fixtures before removing or changing the patch.

An after-hook error can retain the native redirect's HTTP status. The outer request adapter therefore enforces audit failure as a cookie-free, redirect-free HTTP 503, independently of native error conversion. The fixture injects an Organization audit database failure during an otherwise valid, signed OIDC callback and checks that no new bearer is published and that unrelated sessions survive.

The [official SSO](https://www.better-auth.com/docs/plugins/sso) and [SCIM](https://www.better-auth.com/docs/plugins/scim) documentation describes provisioning/identity hooks. The SCIM plugin is compatible and available under MIT. A custom, bounded SCIM adapter was retained to keep provisioning in Organization identity and perform Workspace-scoped revocation through Mikka's existing resource lifecycle, while preserving unrelated personal and other-Organization sessions. No claim is made that the official SCIM plugin is technically incompatible. No Better Auth Organization membership tables are introduced.

## Native Web handoff and SAML session lifecycle

The official Web PKCE exchange creates a distinct native session. Its server-side handoff copies SSO assurance only after reading the source session, identity, provider, Organization and SCIM state from the Auth database. Request bodies cannot supply assurance. It never copies break-glass permission, an Organization role or Workspace membership. The target's assurance and existing identity audit-outbox intent commit together before its bearer can be returned; a failure deletes the unpublished target. Ordinary or no-longer-assured source sessions produce only ordinary sessions, which remain denied by an enforced Organization policy.

Every successful native-verified SAML login retains a private, expiring snapshot of only session ID, provider, NameID and optional SessionIndex. No new snapshot stores a bearer, raw assertion or IdP token. Its lineage self-row fixes that login's original root. Every Web-derived SAML session points to the original root through a hidden native session FK with ON DELETE CASCADE; descendants never become new roots. Handoff locks the root before the source/target and commits a bounded expiry. A session DELETE trigger cleans only the private verification records, leaving descendant deletion to PostgreSQL rather than recursively deleting sessions in trigger code.

The [pinned native SLO implementation](https://github.com/better-auth/better-auth/blob/v1.7.12/packages/sso/src/routes/sso.ts) keeps one canonical provider+NameID record. A later independent login can replace it; its old SessionIndex path warns and still removes that canonical key. The narrow package patch therefore calls an application callback only after the native signed LogoutRequest, issuer, destination and replay checks. An explicit handled result sends the native signed LogoutResponse without running the destructive single-key or ambient-session cleanup. The callback locks and closes the exact matching root families and records the existing audit intent in one transaction. A supplied SessionIndex selects only that login; an absent SessionIndex selects all current roots for the verified provider+NameID, preserving other providers, NameIDs and Organizations. It does not implement an XML validator or relax native verification.

A child-initiated SP logout captures its root from fresh scoped metadata before native processing and deletes that root only after the native endpoint completed its redirect and deleted the child. Root-initiated logout naturally cascades to descendants. Callback errors cannot silently become successful SLO. Both paths preserve a later independent login. Canonical access also rejects a child whose original root has expired or lost its matching assurance.

These handoff/lineage/cache additions are prepared code and test cases until the final public candidate passes the protocol and PostgreSQL suites. The earlier 37/37 result does not cover these additions.

## Live, cache and phone delivery

Workspace data and its metadata use the same current Enterprise principal. Organization live tickets retain their public shape but address a random session/Workspace capability; clients do not derive these channel IDs. Policy, SCIM and native session/proof withdrawal persist capability revocations in the same Auth transaction. Source fan-out checks current membership and canonical assurance, and its final capability SHARE lock serializes with revocation. Existing builtin and Worker transports deliver a durable tombstone, close sockets and reject old tickets. A temporarily older Worker leaves affected capabilities paused until it acknowledges; the source does not fall back to an ambient Organization channel. See [the paired release, lock and rollback contract](../../operations/enterprise-live-authority.md).

Native session delete hooks and custom verified SAML family deletion wake only the existing maintenance path after commit. Directory/member outboxes reuse the pinned WS transaction and acquire APP work in WS→APP order; stable event IDs permit retry after a committed Workspace delivery loses its Auth acknowledgement.

Cache namespace selection preserves the current Workspace/header and member checks, then passes the actual native session principal through the same canonical Organization gate. Denial yields no namespace, including a same-user plain session after SSO enforcement. It never falls back to Personal after this denial.

Phone registration binds a destination to the real authenticated native session; client-supplied session or user IDs are rejected. Sending uses that persisted receiver session, the persisted Bot Workspace and the existing membership lease. An Organization send also shares the policy/session advisory locks and rechecks current Enterprise authority on the held APP executor; native logout, SCIM and policy changes cannot commit past an admitted bounded send. Ordinary destinations cannot receive enforced-SSO content merely because the user has another SSO session. Existing receipts and external delivery remain the production implementation.

## State mapping and migration

| Before | Target | Preserved authority |
| --- | --- | --- |
| Existing human account | Same `user.id`; native issuer + subject binding after explicit proof | Better Auth |
| Existing personal account whose email matches SCIM | Pending link; fresh verified account consent plus signed SSO identity required | Matching email alone cannot link accounts |
| Independent Shared Workspaces | Explicit Organization bindings | Existing Workspace admin must also be Org admin to bind/unbind |
| Individual Workspace members in two Org Workspaces | Union of active human IDs for billing | Existing Workspace membership still authorizes data |
| SCIM User | Organization administrative member; no automatic Workspace membership | Exact case-sensitive `externalId` maps to OIDC `sub` / SAML subject |
| SCIM Group | Connection-scoped directory metadata | Group membership grants no Workspace role |
| Directory inactive/delete/revoked connection | Immediate identity barrier, then durable scoped resource revocation | Personal account and other Organizations remain intact |
| Organization deletion | Owner-authorized tombstone after explicit unbinding and identity shutdown | Audit evidence, detached Workspaces and their history remain |

Migrations are additive and follow Team's `20261109035010`: Workspace-database Organization schema `20261109035020`, auth-database identity schema `20261109035021`, then auth-database SAML session lineage `20261109035022` and live capability authority `20261109035023`. The first two SQL bodies are unchanged from the reviewed versions; only their filenames move after later main migrations. There is no migration from legacy task `scope` into Organization or Workspace ownership. The existing P0 pending-ownership list remains authoritative for ambiguous tasks. No Stripe price, subscription purchase or charge is created.

Rollback is an application rollback with the additive tables retained. A version predating SAML lineage must not issue new descendants while relying on lineage enforcement; drain/revoke affected Enterprise sessions through the existing identity lifecycle before removing that application behavior. Do not drop the hidden session FK or its verification-cleanup trigger while descendants remain. Reverting an enforced SSO/SCIM barrier by deleting rows is not a rollback procedure. An owner first disables enforcement through a verified session or the bounded break-glass flow, completes pending revocations, disables providers and explicitly unbinds Workspaces if removing Organization governance. Restoring a directory account does not automatically restore Workspace membership or resource shares; existing Workspace-admin admission and seat checks apply.

## API contract for the Claude UI session

All JSON bodies are validated server-side. Organization administration requires a fresh session and the current Organization authentication policy. `owner` controls owner promotion, last-owner protection and archive; `admin` can manage ordinary administrative members and policies. Neither role grants Workspace data access.

| Endpoint | Method / body | Result |
| --- | --- | --- |
| `/api/organizations` | GET; POST `{ name }` | Active organizations; create with caller as owner |
| `/api/organizations/:id` | GET; PATCH `{ name }`; DELETE | Summary; rename; retained-audit archive |
| `/api/organizations/:id/members` | POST `{ userId, role? }`; PATCH `{ userId, role }`; DELETE `{ userId }` | Existing-account Org membership; role change; scoped offboarding |
| `/api/organizations/:id/workspaces` | POST / DELETE `{ workspaceId }` | Bind/unbind only with both Org and Workspace admin authority |
| `/api/organizations/:id/identity` | GET; POST discriminated `action` | Redacted state; configure/verify/disable provider, rotate/revoke SCIM, enforcement, bounded break-glass, retry |
| `/api/enterprise/link` | Existing signed-in linking ceremony | One-use short-lived consent cookie, consumed inside native SSO transaction |
| `/api/scim/v2/:connectionId` | Users/Groups CRUD, PATCH, filters, pagination | SCIM 2.0 bounded profile; Bearer credential returned once during rotation |
| `/api/organizations/:id/policy` | GET; PATCH sharing rules, provider allowlist, retention days, legal hold | Explicit policy; durable revocation when tightened |
| `/api/organizations/:id/approvals` | POST `{ workspaceId, kind, resourceId }`; PATCH `{ id, status }` | Resource owner requests; Org admin approves/denies; existing source ACL remains necessary |
| `/api/organizations/:id/audit-log` | POST `{ from?, until? }`; GET `exportId`, `offset`, `limit` | Bounded stable JSON export with manifest/digests and rechecked admin access |

The UI must show Organization roles separately from Workspace membership. Show pending identity linking, unverified domains, explicit scoped offboarding, policy/approval state, the five-minute fresh-session requirement for break-glass, its fifteen-minute expiry, export expiry, retention and legal hold. Render one-time SCIM credentials only when returned; never send them to analytics, request logs, error reports or screenshots. SSO configuration and SAML certificate material stay encrypted at rest. Display separate Workspace audit-export entry points so Org admins do not accidentally receive Workspace resource events they cannot administer.

SAML configuration accepts `logoutEntryPoint` for Redirect and `logoutPostEntryPoint` for POST, so an administrator chooses each binding explicitly. Optional `spSigning: { cert, privateKey, passphrase? }` enables signed SP messages. The backend requires a current RSA certificate, a matching RSA private key of at least 2048 bits, and keeps that key inside the encrypted provider configuration. Generated public SP metadata contains the certificate and native ACS/SLO endpoints; it never contains the private key. Provider configuration replacement invalidates prior assurance and requires renewed domain proof.

An OIDC `configure-provider` response includes both `callbackURL` and `postLogoutRedirectURI`. The UI registers/displays those exact addresses; it must not offer an arbitrary logout redirect input. Use the native logout start endpoint for an assured OIDC session, follow its `url`, and describe a local-only result as local logout. SAML retains its native logout endpoint. These are backend interface requirements; the UI remains owned by the separate Claude session.

## Operator entitlement provisioning

`scripts/organization-plan.mjs` uses existing Workspace-database operator authority; no HTTP route grants a license. Its strict JSON input contains `organizationId`, `expectedPlan`, `plan` (`free` or `enterprise`), `source` (`cloud` or `license`, matching the deployment), `seatLimit`, `expiresAt`, `reason` (`evaluation`, `licensed`, `downgrade`, `correction`) and a non-secret `operator` label. Enterprise requires a finite seat limit; Free has no stored seat override or expiry. An expired or mismatched source cannot grant paid features.

```sh
node --conditions=react-server --import tsx scripts/organization-plan.mjs < grant.json
node --conditions=react-server --import tsx scripts/organization-plan.mjs --apply < grant.json
```

The default command previews before/after capabilities and the union of active human Workspace members. The explicit apply takes the same Organization lock used by admission and binding, rechecks the expected effective plan, and commits the grant with its audit event. Identical replays do not duplicate events. Reducing a limit preserves existing members and reports over-limit state; existing admission controls reject new seat consumption. It creates no Stripe object or charge. Expired licenses retain authority to disable providers, revoke provisioning credentials, disable SSO/machine policy, or use the bounded owner break-glass/retry paths; they cannot enable new enterprise authority.

The Team operator command rejects a Workspace that is currently bound to an Organization, in both preview and apply. It checks the binding while holding the same Workspace lock used by attach/detach. This prevents a dormant local grant from reporting an upgrade that cannot affect the effective Organization plan. Unbound Team Workspaces retain their existing operator flow.

## Durability and audit

Every SCIM User/Group mutation commits an opaque-ID outbox event in the same auth-database transaction. Delivery is serialized per connection and uses the same event ID for Organization audit insertion. PostgreSQL JSONB key reordering must not manufacture changes: semantic deep equality makes an identical replay a no-op. Failures retain the event; explicit retries and the existing durable audit-maintenance timer retry it. Background attempts are bounded and spaced; there is no added minute-polling job.

Identity audit delivery claims one immutable intent in a committed APP statement, releases that pool, inserts the stable event ID in a WS transaction, releases WS, and conditionally acknowledges in APP. Concurrent forced claims cannot duplicate a receipt. A WS failure leaves payload and deliveredAt intact; an APP acknowledgement failure after WS commit also retains the intent for idempotent retry. Existing lastAttemptAt spacing bounds maintenance retries without a permanent claim lease. Prepared max1 tests check the actual pool wait, concurrent claims and both failure boundaries.

Identity administration repeats its current Organization role, license and SSO checks immediately before the mutation and holds the Organization row lock through the Auth DB commit. A concurrent role withdrawal or archive must therefore precede that final check or follow the committed write. DNS/OIDC network discovery stays outside this short lease. Audit and SCIM Workspace delivery run only after its release, so they cannot recursively wait for the same Organization lock. The real database regression observes both competing backend PIDs and verifies the authority ordering; the administrative SCIM retry exercises the subsequent outbox drain.

Inactive identities and revoked/unverified connections fail the Organization gate even when SSO enforcement is off. Workspace membership, scoped PAT/run-token revocation, borrowed credential/share release, stopped runs and bot state use the existing Workspace lifecycle. Personal and unrelated Organization sessions are not globally deleted. Raw assertions, authorization codes, SCIM bearer tokens, client secrets, user query text, document bodies and full conversations never enter ordinary audit metadata.

Organization administrative export reuses the existing canonical audit-digest functions. Export creation and its own audit event commit together, with an immutable record-ID/digest anchor. Every page checks current admin authority and detects alteration, missing rows or reordering. The maximum export is 50,000 events; overlarge requests fail explicitly. Active export leases and legal hold prevent retention deletion. Organization deletion is a tombstone, so it cannot cascade away retained audit evidence. Workspace events continue to use the existing Workspace audit/outbox/export/retention flow.

## Required acceptance

Use an isolated loopback PostgreSQL 17 database whose name passes `tests/helpers/e2e-target.mjs`. `E2E_DATABASE_URL`, `MIKKA_DATABASE_URL` and `DATABASE_URL` must all identify that isolated fixture database. Apply the repository migrations first.

```sh
REQUIRE_DB=1 pnpm test:enterprise-db
pnpm test:governance
pnpm exec tsrs --noEmit
```

`lib/enterprise/http.db.test.ts` performs actual localhost HTTP OIDC authorization/code exchange with PKCE and RSA JWT/JWKS validation, plus generated-certificate signed SAML assertions, correlation/replay/tamper rejection, SCIM lifecycle/replay, two-Workspace revocation and preservation of unrelated identity. Separate SP- and IdP-initiated Single Logout fixtures use independent SP and IdP key pairs, POST and Redirect signatures, signed RelayState, request expiry, provider binding and concurrent replay checks. They reject corrupted signatures before session deletion and preserve an unrelated OIDC browser session. Successful and rejected authentication/logout audit events are asserted in the database. Additional prepared cases cover native Web PKCE assurance and its audit-failure barrier, cache namespace denial for plain/revoked sessions, native phone registration and actual receipt persistence with only Expo/Workflow transport intercepted, original/later SAML SessionIndex selection, no-index IdP logout, child/root SP logout, root-expiry, root-delete/derive ordering and bulk family deletion. Per-run domains make the fixture repeatable against an already migrated test database. This is a standards fixture, not a claim of validation against a customer's IdP.

`lib/enterprise/governance.db.test.ts` exercises Org roles/CRUD, two-Workspace seat deduplication, denial of Org-admin implicit Workspace access, resource approval/revocation, scoped offboarding, export authorization/integrity, retention/legal hold/export leases, and retained-audit archive.

Protocol/DB results must be recorded against the exact candidate commit before merge. Production verification uses only the shared test account in Acme Inc.; no production Stripe or real customer IdP is modified. UI implementation and visual acceptance belong to the delegated Claude session.
