# Coordinator issue mutations

MVP tracker: #357, item 2.

The Coordinator exposes `create_issue` and `update_issue` through its normal
Mikka AI SDK tool registry and the default definition. Both call a durable
Workflow step, check `assertNativeToolScope` first, and reuse
`lib/mcp/actions.ts`. No native Coordinator runtime is enabled.

## Contract

`create_issue` takes a title and optional plain-text body, status, priority,
labels and `assigneeUserId`. `update_issue` takes an issue id and optional
title, status, priority, labels and `assigneeUserId`. Assignees must be people
already allowed on the task (R-60); execution identities are not accepted.
An omitted field stays unchanged, and a supplied label array replaces the
label set. A null human assignee clears the assignment.

The tools intentionally do not expose project moves. Project membership
lives in the workspace database; these durable issue mutations use one
application-database transaction. Existing external MCP project operations
remain available with their existing authorization.

## Retries and followups

The AI SDK's `options.toolCallId` is mandatory for the two Workflow steps.
`issue_tool_calls` keys a receipt by user and call id and records the operation,
normalized input hash, result and pending followups. An advisory transaction
lock serializes duplicate callers. A changed input or operation with the same
key fails; a different user has a separate key space.

The shared actions run in the receipt transaction. Their existing transactions
become savepoints, so creating an issue, writing metadata/history and recording
the result either all commit or all roll back. A successful retry returns the
original result and checks current issue access before doing so. It cannot
overwrite a later edit or allocate a second issue number.

Linear outbox processing, automatic issue-scope judgment and Coordinator wakes
are captured as followup descriptors during the write, then run after commit.
Workflow steps do not depend on a Next.js request's `after()` context. If the
step fails after commit, a retry resumes its pending followups without repeating
the issue mutation. These followups use the existing outbox and wake semantics.
Normal UI actions continue scheduling the same work with `after()`.

## New-task entry

The existing dialog keeps its layout. Mikka Cloud is first and selected by
default (R-22/R-23); the person's chosen local machine remains in the request.
Submitting preserves a request UUID across a retry with the same text, so a
lost acknowledgement cannot enqueue the same request twice. The Coordinator's
instructions require creating the issue before dispatch and retaining the
task if execution is unavailable. It must not silently switch machines.

## Verification

- Source tests cover schema restrictions, registry grants, tool-call identity,
  scope revocation, receipt replay and pending-followup recovery.
- `tests/issue-tool-calls.db.test.ts` invokes the real registry, step and shared
  actions against CI's disposable PostgreSQL 17. It covers concurrent duplicate
  creation, partial-write rollback, history preservation, replay after a later
  edit and owner isolation.
- The DB suite is in the required inventory; `tests/migrate-empty-db.test.mjs`
  validates the append-only receipt migration and schema during CI.
- Full chat-to-daemon browser acceptance belongs to #357 item 6. A source test
  or skipped DB test is not evidence that deployed acceptance passed.

No new production environment variables are required.
