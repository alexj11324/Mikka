# Metadata visibility integration (#169)

Independent candidate based on #280 `26bb41c34f0c29f1ba7f71a6d9e7bce46bd00098`,
merging #169 `1cc27501486676b312adb1cf1a76ee4ab6298aa1`. Source branches stay
unchanged. R coordinates main merge; this is not production acceptance.

Teammates see only the existing #169 status/timestamp/harness projection. Private
agent identity, prompt/instructions, arbitrary report/error/stop text, transcript
and messages stay owner-only. Run controls and event reads remain owner-only.
Personal tasks never inherit workspace membership or legacy invitations.

Integration preserves #280 application/workspace transaction executors in
issueForUser, mailbox writes, Factory dispatch and current device/worker
revocation. Issue execution with an existing workspace link requires current active membership,
including an owner-personal task with a legacy link; metadata sharing does not
replace this execution check. Owners retain their existing run-history reads.
No cross-database atomicity or new authorization model is claimed.

The retained-fixture core test accepts explicit isolated loopback databases ending
in `_e2e`; it never falls back to business DBs. It verifies separate app/workspace
connections, uncommitted executor-local changes, private tasks, metadata projection,
member suspension and worker-token recheck. Fixtures use current `mikka_*` table
names and priority constraints. No DELETE cleanup occurs.

`scripts/visibility/http-acceptance.mjs` requires two distinct loopback `_e2e`
databases and a loopback Next server. It calls the existing MCP HTTP endpoint with
synthetic OAuth credentials, checks the exact wire allowlist and denies foreign
workspace/private events, then tests membership and scope changes. It also checks
existing daemon heartbeat revocation; the unchanged complete owner-revoke API,
races, SQL failure handling and broker cancellation run in the dedicated daemon
regression. Only safe result metadata is written to artifacts, never tokens.

#168 actor and #170 search remain separate candidates. Their writer/search changes
are not bundled here. Production identities, frozen deployment, real-user
acceptance and redacted PR video remain parent-coordinated and unverified.

## Agent assignment options (P2 functional follow-up)

`getIssuePropertyOptions` returns `capabilities.canAssignAgent`. Only the task
owner receives their own Agent choices and may assign an Agent. Nonowners receive
an empty Agent list and `false`; submitting a known private Agent ID is not a
capability bypass. The existing `agents.userId === issue.userId` check remains.
Other permitted metadata edits and clearing an assignment keep their existing
contracts. No UI layout is changed; this addresses inconsistent choices, not a
claim of a demonstrated security disclosure.

`scripts/visibility/assignment-http.mjs` calls the actual built Next Server Actions
using IDs from that build's server-reference manifest. Synthetic signed-in sessions
read options and submit selections over HTTP; retained PG state verifies owner
success, member/foreign Agent refusal, member label-edit success and refusal after
workspace revocation or a personal-scope flip. This is real action/HTTP acceptance,
not a browser interaction or production verification claim. Cookies/tokens and
raw action responses are never written to the evidence artifact.
