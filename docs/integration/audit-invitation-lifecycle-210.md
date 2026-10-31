# Invitation lifecycle audit (#210)

Base: `e5261087`, cloud Linux, current workspace actions and the existing durable
audit outbox. An ordinary invitation acceptance changed membership without an
exportable `member.joined` event; revocation changed invitation authority without
its existing `member.invitation_revoked` event. Occurrence 8 × impact 6 = 48:
these are routine authorization changes, and an admin's incident export could
omit how a member gained access or who cancelled an invitation.

Both actions now enqueue their existing allowlisted event in the transaction
that changes authorization. The actor is the authenticated user. Revocation
uses the returned pending invitation ID and emits only for an actual transition;
repeated requests cannot add duplicate events. Acceptance emits `member.joined`
only when it inserts membership, after the existing email, pending/expiry,
workspace lock and suspended-membership checks. Accepting a new invitation as an
existing active member does not invent another join. Invitation bearer material
and token hashes are not stored in either event. Failure to persist audit intent
rolls the authorization change back.

Actual PostgreSQL component verification used the existing isolated main and
workspace databases on `127.0.0.1:55599`, without a new database or container.
`tests/audit-delivery.db.test.ts` passed 8/8 with no skips, including actual action
implementations, transaction rollback injection, member denial, replay, new
process delivery, and sink readback. Authentication and Next request boundaries
are explicit test fixtures; this is not a claim that a deployed browser/session
flow or external provider was exercised. Log:
`/tmp/mikka-remaining-invitation-audit-db.log`. Typecheck and targeted lint passed.

This closes the identified invitation-event gap. #210 still includes other
authentication/denial/Agent-action event coverage and its full fixed-application
acceptance; this slice alone does not justify closing the umbrella issue.
