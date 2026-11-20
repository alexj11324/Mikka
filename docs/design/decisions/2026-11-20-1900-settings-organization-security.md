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
