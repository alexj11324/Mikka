# Enterprise account deletion

Account deletion uses the existing two-store deletion job. Organization membership is authoritative only in `DATABASE_URL`; identity, providers, sessions and personal tokens live in `MIKKA_DATABASE_URL`. An APP table with the same Workspace/Organization name is not membership authority.

## Ownership and configuration

The existing Organization `last_owner` rule also applies to account deletion. A request by the last owner of an active Organization is refused before external cleanup. It removes that unstarted request's guards in both stores and records a cancelled receipt, so the owner can continue managing the Organization. An active owner with a committed canonical account-deletion guard does not count as a remaining owner for another deletion, demotion or member removal.

The account request inserts its canonical guard and checks ownership under Organization row locks in the same Workspace transaction. Where Workspace locks are already held, the order remains Workspace, Organization, then APP. Before external cleanup and immediately before the APP deletion, ownership is checked again. If an irreversible phase has already started, a later refusal stays retryable with `blockedReasons: ["last_owner"]`; it is not reported as an undone cancellation.

Organization creation and explicit member admission/role changes use the existing canonical `mikka_account_assert_writable` barrier. The SSO and SCIM membership writers use that same barrier at the start of their Workspace transaction, so an in-flight identity delivery cannot recreate a departing member. A failed SCIM delivery keeps its existing durable outbox intent for retry.

The SSO provider belongs to its Organization. Its nullable `userId` is creator attribution. Account cleanup excludes `enterprise_sso_provider` from the generic owner-column sweep; the existing user foreign key sets only creator attribution to NULL. Other users' identities, SCIM connection, encrypted configuration and Organization audit history remain. The Org-owned `enterprise_scim_user` directory row is also retained under its original user foreign key: deletion clears `userId` to NULL, while the corporate profile remains administered by SCIM. A previously committed SCIM intent then uses the existing `pending_link` audit-only branch, so it cannot recreate the deleted account's Organization or Workspace membership or block later directory events. A truly missing directory row still raises the existing delivery error. Personal sessions, account tokens and the departing person's identities are removed by the existing account cleanup. Organization membership is explicitly removed in the canonical Workspace phase, including recovery after the APP phase has committed. Each actually removed row emits the existing `organization.member_removed` event in that same Workspace transaction with only `reason: account_deletion`. Audit failure rolls back that membership removal; retries with no row do not duplicate the event.

## Existing error contracts

- Organization management HTTP continues to return HTTP 409 with `{error:{code:"governance_denied",detail:"last_owner"}}`.
- Account deletion POST returns HTTP 409 with `{error:"accountLastOrganizationOwner"}`.
- The account Server Action returns `accountLastOrganizationOwner`; the existing English and Chinese Errors dictionaries contain the same last-owner wording already used by Organization management.
- No Organization IDs, membership lists or provider secrets are added to a refusal response.

No schema or migration is added. Restore replay must use its explicit target pools. The isolated restore test includes real Organization table definitions and different source/restore memberships, so an unqualified lookup cannot silently fall through to source tables.

## Regression evidence to collect on the published commit

These new scenarios are prepared for real PostgreSQL and HTTP execution; source review alone is not an executed pass:

1. Last-owner account deletion calls no external cleanup, preserves the user/session/audit, cancels the unstarted receipt and clears both account guards.
2. A second owner cannot demote or remove itself by counting a deletion-pending owner. The refused original owner remains able to manage the Organization.
3. Two deletion requests wait on a real canonical Organization row lock; at most one is admitted. A remaining owner performs real APP and Workspace writes, and a completed deletion removes only its canonical membership.
4. A misleading APP mirror cannot authorize deletion against the canonical Workspace owner set.
5. Existing standard OIDC/SCIM fixtures create a real peer identity. A creator's account deletion retains the provider configuration and peer login while deleting the creator's sessions/PATs and preserving historical audit.
6. The existing SSO and SCIM membership writers refuse a deletion-guarded account. SCIM's committed intent retries after cancellation without duplicate audit. A separate real completion case deletes the account, sessions, PATs and identity; its directory mapping becomes NULL, the pending intent records `pending_link` once, and the next member on the same connection is delivered normally.
7. A real audit constraint failure leaves the APP phase committed and the canonical member unchanged; retry removes the member with exactly one audit event. Existing historical audit rows are compared by their original IDs, separately from new removal events.
8. Restore replay removes the old member only in its isolated canonical target and retains the independent source membership, prior Task-retention assertions and a single removal audit across repeated replay.
