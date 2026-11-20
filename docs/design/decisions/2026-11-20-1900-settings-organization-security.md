# Organization security and scoped invitations

Scope: [settings backend P7](https://github.com/alexj11324/Mikka/issues/2956).
This decision defines the backend contract for the frontend in
[#2957](https://github.com/alexj11324/Mikka/issues/2957); implementation and
verification remain tracked by the owning pull request.

## Decision

- Extend the existing allowed-domain records with an organization-bound DNS
  TXT challenge and verification receipt. Domain admission requires a verified
  record. The administrator's matching verified business email remains required
  when adding a domain. The verification endpoint returns the exact TXT record
  and a checked/verified result, with no authentication secrets in audit events.
- Use the installed Better Auth two-factor plugin for TOTP enrollment,
  verification and single-use recovery codes. Keep enrollment verification and
  the plugin's rate and attempt limits. OAuth-only accounts may enroll through
  the plugin's passwordless-account option; credential accounts still need their
  password for enrollment and recovery-code management.
- Organization `requireTwoFactor` is enforced through the existing organization
  and workspace authentication gate. A verified authenticator on the account
  does not establish that a particular session completed a second factor.
  Record successful native TOTP/recovery verification on that session, and
  require that assurance after the policy's enrollment grace period. Personal
  account access remains available so a member can enroll or recover.
  Viewing the enrolled TOTP secret, replacing recovery codes, and disabling
  MFA require a verified session as well. A native trusted-device login may
  satisfy the plugin's password challenge, but an organization still requires
  an explicit TOTP/recovery receipt on that new session.
- Extend the existing invitation writer with `role: admin | member` and an
  explicit list of team IDs. Ordinary members can continue issuing unscoped
  member invitations. Administrative roles and team scopes require organization
  administration; each scoped workspace also requires the issuer's own active
  administrative authority. Recheck it on acceptance. An unscoped organization
  invitation never grants workspace or team access. A scoped invitation grants
  only the named active teams and their required member-level workspace access.
- Do not introduce role permission templates. #2956 does not define a distinct
  role-capability contract; retain the existing owner/admin/member roles and
  existing resource approval templates.

## Compatibility and verification

Keep the invitation and domain routes and all existing SSO/SCIM gates. Add
typed columns and tables with the repository's migration generator. Rollback
retains data and disables enforcement through the authenticated policy writer;
it does not delete authenticator secrets, recovery codes or member history.

The installed Better Auth 1.7.12 plugin automatically challenges password-based
sign-in paths, but does not establish MFA assurance for every OAuth/SSO session.
The organization gate must independently verify the session receipt. Confirm
the real plugin's enrollment, TOTP, recovery-code and session behavior against
isolated PostgreSQL 17, alongside foreign-organization, ordinary-member,
revoked-invitation and cross-workspace rejection cases.

Reference: [Better Auth two-factor documentation](https://better-auth.com/docs/plugins/2fa).

## HTTP contract

All paths below include the deployment's existing base path. Shared JSON types
live in `lib/governance/organization-security-contract.ts`; the native client
plugin is registered in `lib/auth-client.ts`. These are account/organization
security requirements, so they do not inherit a personal override or return a
settings `source` field.

| API | Request / authorization | Response |
| --- | --- | --- |
| `GET /api/me/security` | Fresh authenticated account; no client-selected user ID | `{ twoFactorEnabled, sessionVerified, organizations: [{ organizationId, name, requireTwoFactor, graceEndsAt, status }] }` |
| `GET /api/organizations/:organizationId/security` | Active organization owner/admin and current organization authentication policy | `{ policy: { requireTwoFactor, gracePeriodDays, requiredAt, graceEndsAt } }` |
| `PATCH /api/organizations/:organizationId/security` | Same authority; `{ requireTwoFactor, gracePeriodDays?: 0..30 }`; enabling requires the administrator's verified current session | Same policy response. Default grace is seven days. Updating an enabled policy preserves its original activation date. |
| `POST /api/organizations/:organizationId/allowed-domains` | Existing verified matching business-email owner/admin; `{ domain }` | Existing domain receipt plus `{ dns: { type: 'TXT', name, value } }`. A new grant is pending. |
| `POST /api/organizations/:organizationId/allowed-domains/:domainId/verify` | Current owner/admin of this exact organization | `{ domain, dns, verified }`; domain adds `verifiedAt`, `lastCheckedAt`, `verificationError: null \| record_missing \| lookup_failed` |
| Existing organization invitation creation | `{ emails, role?: 'admin' \| 'member', teamIds?: string[] }` | Existing per-email outcomes. Ordinary members may only use the default member role and no teams. |
| Existing organization invitation list | Existing owner/admin/member visibility | Existing rows add `role` and `teamIds`; member senders can still see only their own rows. |
| Existing invitation acceptance | Verified addressed account; current organization authentication policy | `{ organizationId, joined: true, role, teamIds? }`; no scopes means no workspace grant. |

Personal organization status is `not_required`, `grace`,
`enrollment_required`, `verification_required`, or `verified`. The grace
deadline applies to admission and existing organization/workspace access.
Personal security and the native verification endpoints remain usable after
it expires. Existing SSO, SCIM suspension and workspace membership gates still
apply independently. Machine credentials retain their existing credential and
SSO policy, while their human account must have enrolled when MFA is required.

Native Better Auth endpoints are under `/api/auth/two-factor`:

- `POST /enable` with `{ password? }` returns the native `{ method: 'totp',
  totpURI, backupCodes }`. Accounts with a password must supply it; OAuth-only
  accounts use their authenticated session. Enrollment is incomplete until
  `POST /verify-totp` with `{ code }` succeeds.
- `POST /verify-totp` and `POST /verify-backup-code` perform native challenge or
  authenticated-session verification. They record assurance only for the
  verified session. Recovery codes are native single-use encrypted records.
- `POST /get-totp-uri`, `POST /generate-backup-codes` and `POST /disable` keep
  native password/session checks and additionally require current session MFA
  when the account is already enrolled. Disable is denied while any active
  organization requires MFA, including during its grace period.

Use the native authentication result/cookies and `set-auth-token` header for
session rotation. Treat TOTP URIs, codes and recovery codes as secrets: only
return them through the authenticated native endpoint, never audit or log them.
Pending password MFA returns `twoFactorRedirect` and no authenticated session
or desktop session cache. A new verified sign-in is audited with method `totp`
or `recovery_code`; failed audit delivery intent withholds the new credential.

## Persistence and rollback

Generated additive migrations `20261120185258_settings_organization_security`
and `20261120185353_settings_organization_admission` add native authentication
storage, typed policy/session fields, domain receipts, invitation role and an
invitation-to-team relation. They are repeatable. SQL bytes are frozen after
execution. Changes to account MFA clear every old session receipt; new native
sessions always start without one. A removed team is retained in a pending
invitation's scope relation so acceptance fails instead of silently widening
that invitation.

Existing domain grants become pending until an administrator proves the DNS
record. Existing memberships are retained. Existing invitations keep the
member role with no workspace/team grant. For rollback, disable organization
MFA through the current verified administrator endpoint before reverting code,
retain the additive data, and stop domain admission/revoke scoped pending
invitations before running code that predates their checks. Do not delete
authenticator records or reinterpret pending domains as verified grants.

## Verification owners

`tests/organization-security.db.test.ts` runs the production Better Auth
handler, native plugin, cookies, bearer resolution, audit and policy routes
against local PG17. An independent RFC 6238 test authenticator reads the
native URI; production never implements its own TOTP or recovery-code logic.
It checks account ownership, ordinary/cross-organization denials, grace and
post-deadline access, per-session assurance, native recovery and rate limits,
and audit-failure withholding. The existing organization invitation/domain
PG suites cover the added role/team boundaries and DNS-bound grant admission.
DNS resolution is the external mocked boundary; persistence and authorization
are real. `test:enterprise-db` and the existing DB inventory include the new
suite. CI at the owning PR head remains the final merge gate.
