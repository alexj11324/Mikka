# Factory human approval uses a live Mikka session

- Date: 2026-11-09
- Source: [#1503](https://github.com/alexj11324/Mikka/issues/1503) requires the normal smoke account to complete “派任务 → 开 PR → 要求修改 → 合并”. This records the backend compatibility decision for that requirement, alongside the supported sign-in methods in `lib/auth.ts` and the existing [separation of GitHub connection from sign-in](2026-11-01-0303-github-plugin-connection-separate-from-login.md).
- Rule: —
- Replaces: only the linked GitHub/Google account requirement in [194 v1](../../factory/194-approval-contract-v1.md), [194 v2](../../factory/194-main-approval-v2.md) and [494](../../factory/494-approve-and-publish.md). Their other ownership, evidence and publication requirements remain.

## Context

Mikka supports email/password and configured Apple, GitHub and Google sign-in.
The Factory route authenticates a real browser or native session, but its
approval service also required a linked GitHub or Google `account` row. That
excluded a person signed in with a supported password account, even when the
same session could read the candidate and operate its task. It also excluded
Apple-only accounts.

The account-link predicate was an explicit older eligibility rule. It was not
proof of the current session's sign-in method: a person could sign in with a
password while retaining a GitHub link. A normal GitHub repository connection
is stored separately in `github_connections` and deliberately does not create
a sign-in account.

## Decision

A Factory human decision requires a verified, live Mikka browser or native
session belonging to the person authorized for the task. All sign-in methods
supported by the application's authentication service can establish that
session. Approval does not require a separate OAuth account link.

The route continues to derive the actor from `auth.api.getSession` with
`disableCookieCache: true`. Request JSON cannot choose the person or session.
An explicit native Authorization header is authenticated independently of
ambient cookies. PAT, MCP and daemon credentials cannot become human sessions,
and an invalid bearer cannot fall back to a valid browser cookie. POST requests
retain the same-origin check.

Inside the existing transaction, `humanApproval` requires both actor IDs and
locks the matching, unexpired `session` row with `FOR SHARE`. Removing the
account-link predicate adds no query or network call. The task's owner/issue,
Bot/source, current candidate, revision, STOP, repair-budget and evidence checks
remain in force. Request changes remains a human decision recorded against the
authenticated person.

Code acceptance still needs the person's independent GitHub authorization.
`merge.ts` already checks the live task-owner session, then obtains the
person's GitHub user token and verifies the exact PR head before requesting a
merge. A repository token cannot replace the session, and a Mikka session alone
does not grant GitHub merge permission. Non-code deliverable acceptance keeps
its existing live-session and evidence checks.

## Verification and consequences

The regression in `lib/factory/approval.test.ts` signs in through real Better
Auth over loopback HTTP with only a disposable `credential` account. No OAuth
link remains to make the test pass. It covers approval/publication, request
changes, foreign-origin and delegated-token rejection, and sign-out. Existing
owner, expired-session, STOP and candidate checks remain covered by the approval,
reject and merge suites. The native-header unit test checks the adapter boundary;
it does not claim a live Apple or other OAuth login.

This change needs no account migration, provider-link fabrication, login-method
switch or smoke-account exception. GitHub connection and merge authorization
retain their separate contract. Local regression results do not stand in for
the complete production Factory delivery acceptance required by #1503.
