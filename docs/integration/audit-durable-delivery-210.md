# Cross-store audit delivery — #210

Base: `7870de3cf90d95b01a54d5518418f6bac8f7456d` (includes merged `a703b0ef`).
Issue #210 remains open with its original requirements and no comments/superseding
owner decision. This change addresses its existing cross-store audit-loss path,
not OAuth, UI configuration or the remainder of its event catalogue.

## Reproduced failure

The existing role/invitation/settings actions committed `DATABASE_URL` and then
called `recordAuditSafe` against `MIKKA_DATABASE_URL`. On main audit write failure,
that helper logged a sanitized error and returned null. There was no durable
intent to retry after the request/process ended. Occurrence 5/10, impact 8/10
(40), and an audit/accountability requirement independently of that score.

Before changes, the actual writer and workspace SQL ran against PG17 logical
stores `mikka_audit_closeout_e2e` and `mikka_audit_durable_workspace_e2e` on the
existing loopback server. A workspace-scoped CHECK constraint rejected the main
audit insertion: the member role remained committed as admin, the writer returned
null and main contained zero audit rows. The constraint was removed afterward.
Private local evidence: `/tmp/mikka-audit-durable-before.log`.

## Minimum delivery boundary

A workspace transaction now writes the validated existing `toAuditRow` payload
into `workspace_audit_outbox` with its final audit UUID and UTC creation time.
Invitation, role/status, slug, ownership transfer and member-removal call sites
all enqueue inside their existing workspace transaction. An enqueue/validation
failure rolls that workspace mutation back. Audit intent is written before any
existing optional cross-store bot transfer; the change does not claim a
transaction spanning both databases or redesign those asset transfers.

Existing coordinator and Linear queues are in the main database and carry
specialized application events, so neither could atomically hold this workspace
intent. The additive workspace receipt has no parallel status machine: a pending
payload, last attempt and eventual acknowledgment. There is no subject/workspace
cascade that could erase an undelivered receipt.

The already-scheduled `/api/cron/audit-retention` tick delivers a bounded batch
before retention. A row lock with SKIP LOCKED coordinates concurrent consumers;
last-attempt ordering lets a failed item yield to other pending work. No new
scheduler, service, flag or external message is added. Normal collection is
asynchronous through this existing minute tick.

The main sink uses the receipt UUID as its existing primary key. A conflict does
not overwrite a row: the worker reads back and checks the complete normalized
payload, original timestamp and PostgreSQL inet equality before acknowledging.
A mismatching row remains pending. Main insertion and readback commit first;
source acknowledgment commits separately. If the source acknowledgment fails,
the next process verifies the same main row and finishes without a duplicate.
Only after acknowledgment is the source payload cleared, retaining a content-free
receipt rather than duplicating the full event payload indefinitely.

`recordAuditSafe` remains a legacy best-effort compatibility API; it has no
production workspace mutation callers after this change. Same-main-store writes
still use the existing transaction-bound `recordAudit` directly.

## Verification and limits

Real PG component tests exercise the actual role/invitation actions and settings
backend functions. Only identity/request adapters are explicit fixtures; both
logical databases, transactions, failure constraints and readbacks are real.
A newly spawned Node process resumes the persisted receipt to prove restart
recovery. Cases cover audit-write failure, queue-write rollback, lost source ack,
ID/readback mismatch, valid IPv6 normalization, member denial, invitation-token
exclusion, transfer/removal snapshots and delivery after subject removal.

Local commands use all three initial E2E URLs pointing at the existing isolated
main test store plus `AUDIT_WORKSPACE_DATABASE_URL` for the distinct isolated
workspace test store. Without that optional local fixture URL, CI creates and
cleans up its own loopback `_e2e` workspace database; existing database-target
checks are preserved. This is component evidence, not a claim of complete #210
application acceptance. No customer data, production store, OAuth flow or
third-party SaaS was accessed or changed. No build/install was run.

Evidence: `/tmp/mikka-audit-delivery-db.log` (6/6); unit/settings wrapper evidence
and the final commit revision are supplied with the handoff. Local full typecheck
was initially blocked by unrelated missing cached `@tanstack/react-virtual` and
`undici` dependencies; no dependencies were installed to bypass that limit.


The outbox migration was first exercised locally as
`20261031050304_workspace_audit_outbox.sql`. Before this commit its unchanged SQL
was renamed to `20261031052204_workspace_audit_outbox.sql`, after the shared
integration migration tail; the earlier evidence retains its original name.


After the parent made its exact-lock cached dependencies available, rerunning
`/tmp/mikka-old-worktree-deps.py` added only local links and the full typecheck
passed (`/tmp/mikka-audit-delivery-types-linked.log`). No install was needed.
Final two-store/new-process tests remain 6/6; settings/maintenance units 12/12,
required DB inventory tests 15/15, the actual `test:audit` command and targeted
oxlint also pass. No root worktree or frozen #576 source was changed.
