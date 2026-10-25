# Synthetic PostgreSQL / mailbox composition evidence

These are raw test stdout/stderr logs from task-owned cloud Linux PostgreSQL17 databases. References, owners and payloads are synthetic. No real credentials, provider logs or user screenshots are included. They are backend test evidence, not production acceptance.

Frozen source inputs: #268 a3294781eae74d824087c9c80bfc3f6093f196d7; #270287368daf6e1286afb8b461642a577e5bae17cfb; #2591b39b709ce361b9643524aea983860e6de818ff6. Uncorrected combination c76be2e; fixed combination #272ee5ae6a0f1d8804fd58a18c80652545fc38cbaaa.

- `268-base-regressions.log`: exact frozen production source plus new regression test overlay; old40P01 and cross-retry MCP receipt mismatch reproduced. Failures intentionally retained.
- `270-fixed-mailbox.log`:32/32 mailbox/prompt tests on standalone270, including old completion/send FK barrier.
- `272-initial-harness-failure.log`: initial combination run failed an explicit SQL parameter cast and a fixture that incorrectly set immutable lineage via UPDATE. Neither trigger nor production rule was disabled; corrected fixture creates lineage at INSERT.
- `272-combined-deadlock.log`: uncorrected combined production source, corrected harness, real40P01 remains (17pass/2fail including aggregate parent). This disproves extrapolating270 green to the audited combination.
- `272-fixed-both-orders.log`:32/32 tests on corrected combination; ownerSend/completion barrier forces both C<M and M<C UUID ordering.
- `272-audit.log`:12/12 audited PostgreSQL tests, including original stop/completion barrier, inherited tenant scope, failures, export/legal hold/retention. Functional retention and tamper tests alter only their seeded synthetic rows. Databases and containers are retained; no production SQL or resource cleanup occurred.
- `272-next-mcp-retry.json`: actual Next mailbox route plus shipped MCP stdio, response socket loss, process restart, three same-receipt replays, old/revoked token401, independent sender same-key creates its own envelope. Retry and synthetic token rows were seeded by SQL, **not daemon reclamation**. No provider was invoked.

The Next runtime ran on a Docker internal network with no outbound provider access. A local127.0.0.1 proxy exposed it only to the local test runner. Relevant runtime source hashes matched the clean frozen checkout. Initial local native SWC cache validation and missing Playwright ffmpeg failures were environmental; the native guard was not disabled. The corrected environment used the standard node24 container and installed the test video tool. Actual audit HTTP24 requests and continuation HTTP11 requests passed; separate API-screen recording remains private and is not product/production video.

Authorization checks on already revoked tokens passed. The pre-existing post-check/in-flight revocation race is outside this fix. Historical duplicate envelopes require explicit reconciliation. No claim of universal message/external-effect exactly-once, production deployment or completed production acceptance is made.
