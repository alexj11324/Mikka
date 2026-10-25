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
