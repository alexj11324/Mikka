# Operation readback after worker failure (#208)

Base: `be539ca31449e52b8b361da6d99e74ed63f72836`.
Branch: `codex/old-208-operations`. No migration or new availability flag.

## Verified defect and change

An external effect can succeed before its receipt transaction commits. The
existing durable invocation marker correctly prevents a resend after a worker
crash. However, once the originating agent execution becomes `failed`, an
authorized human's attempt to reconcile the operation was rejected with
`writeRunUnavailable`, before the provider could perform readback.

Occurrence 3/10 × impact 6/10 = 18: worker/process failure after an external
write is a normal recovery case, and the old behavior left its result unknown.
The PostgreSQL/HTTP regression fails on the base and passes with this change.

A human decision on an already-invoked operation now selects a readback-only
policy mode. It still checks the current session, owner, tool/policy version,
original approval and exact execution binding. That mode accepts a failed
originating execution only for `read` and `reconcile`; reservation, claim,
invocation and settlement cannot use it. The original `executionRunId` remains
unchanged, and a retry run cannot inherit the old proposal's authority.

Provider lookup now runs within the existing membership authorization lease.
A missing remote result keeps the current executing/uncertain state, so a
concurrent readback cannot invalidate a claim before its first invocation.
Neither path resends an external write.

## Local evidence

Cloud Linux, PostgreSQL 17, dedicated `mikka_old208_e2e` on loopback port
55599. Each test uses a separate retained schema populated with the production
operation/policy migrations. No existing database ledger was changed.

- `pnpm test:approved-writes`: 74 passed, zero skipped.
- `lib/operations/recovery.db.test.ts`: 2 passed, zero skipped. Ten concurrent
  reservations/claims produce one operation and one HTTP effect. A separate
  worker receives the remote success and is killed before receipt writeback;
  a different process using a current human session reconciles the same
  operation without a second POST.
  Wrong owner, expired session, denied membership, current deny and stale/new
  worker attempts are rejected.
- `lib/operations/write-policy-chain.db.test.ts`: 1 passed, zero skipped.
- Root TypeScript, targeted oxlint and `git diff --check`: passed.

Logs: `/tmp/mikka-old208-baseline.log`, `/tmp/mikka-old208-focused.log`,
`/tmp/mikka-old208-approved-writes.log`, `/tmp/mikka-old208-policy-chain.log`,
`/tmp/mikka-old208-types.log`.

The independent loopback HTTP service intentionally does not deduplicate
POSTs; an accidental resend would produce another effect and fail the test.
Its objects survive the worker process crash. Authorization/session rows are
explicit local fixtures; this is real PostgreSQL, transport and process-failure
evidence, not full Mikka chat, Better Auth signup or live SaaS acceptance.

## Integration and remaining acceptance

Append `lib/operations/recovery.db.test.ts` to the existing
`test:approved-writes-db` command. The parent integration owns shared script
and CI inventory updates and will record the final Git-linked CI revision.

At this increment's base the Composio adapter returned no automatic readback receipt.
Such operations remained uncertain without a verified provider result. No real
Notion/Slack/Calendar write, OAuth flow or production action was performed.
#208 remains open until its real-provider and complete system requirements
are verified; these tests do not claim universal exactly-once behavior.

## Subsequent merged Slack readback

Main now includes `lib/operations/slack-delivery.ts`. New Slack sends use the
fixed `slack-message-metadata-v1` proxy contract, binding the stable operation
key and approved payload digest in Slack message metadata. Readback follows
provider history cursors, requires both values to match, and obtains the real
permalink when available. A text match alone never establishes a receipt;
legacy sends without the correlation metadata stay uncertain. The current
owner connection is checked before lookup. Other unsupported provider lookup
paths still return no receipt rather than inventing success.

This supersedes the earlier no-readback statement only for that explicit Slack
contract. Its PostgreSQL/HTTP and provider-contract evidence does not claim a
live Slack write/readback. The owner excluded our live third-party acceptance;
that item stays skipped without requesting another OAuth flow or test target.
