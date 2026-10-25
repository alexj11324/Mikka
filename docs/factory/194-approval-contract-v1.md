# Factory #194 approval/publish consumer v1

Base: coordinated #191+#192 `4cd3a1b5fa05773094722bab7774e15a8d49d018` (fast-forwarded from frozen PR197 `605bf086d4371e19f2df2e2857a487f1decd649d`). The [#192 contract](192-contract-v1.md) and `lib/factory/contract.ts` are unchanged. `createFactoryApprovals` uses `createFactoryStore(pool, authorize, gates)` and its existing `read/apply` transaction boundary. There is no second stage source, scheduler, Harness or worker permission system.

## Dependencies and installation

`lib/factory/server.ts` installs only `approvalGate` and `publishGate`. #193 must compose its own review/verify gates into that same store. They are absent on this candidate and remain closed. #194 never promotes executor self-report into an independent result. Existing daemon candidate commit/push is unchanged: it precedes candidate review and is not a merge/deployment approval.

Migrations: #192 `20261025013402_factory_192_stages.sql`, imported #191 `20261025013401_run_dispatch_keys.sql`, new #194 `20261025013403_factory_194_approvals.sql`. The obsolete `20261025004500` and `20261025011101` filenames are not present. The new migration is reentrant and adds consumer ledgers only.

## Browser API

`/api/factory/tasks/:taskId/approval` uses the existing Better Auth browser session. Authorization headers (including MCP OAuth, worker and daemon credentials) are rejected. JSON cannot select an actor. The adapter disables cookie-cache lookup; transactions also recheck the actual unexpired session and linked Google/GitHub account, task owner and current issue access. An account link is an authentication prerequisite, not proof that a human has performed this acceptance run.

- `GET`: read the fixed candidate evidence inventory. Returns the full #192 binding, exact candidate identity, artifact hashes and original run/session/time provenance, evidence digest and a persisted read receipt bound to this browser session and fence.
- `GET ?artifact=run-report:UUID` or `run-chunk:UUID`: read an inventory artifact back from existing access-controlled storage. Known credential fields/formats are redacted in the response. The hash refers to the original source; raw contents are never copied to the approval ledger. Redaction is defense in depth, not a certification of arbitrary producer output.
- `GET ?view=ledger`: read the human approval and publication history without browser session tokens.
- `POST {operation:"approve",input:{binding,eventId,candidate,action,target,expiresAt,evidenceDigest,evidenceReadId}}`: same-origin cookie operation. `candidate` has exact `sha/repository/environment/scope`. `action` is `deploy_preview`, `deploy_production` or `merge`; `target` is the exact registered target identifier. Expiry must be in the next 24 hours. The same authenticated session must have read that fixed evidence inventory. Approval finish and advancement to the single existing publish attempt occur atomically with the approval ledger.
- `POST {operation:"revoke",input:{binding,eventId,approvalId}}`: revoke with the current fence. An append-only control event records the authenticated user/session and exact payload; changed replay payloads are rejected.
- `POST {operation:"publish",input:{binding,eventId,approvalId,action,target}}`: execute only a trusted backend adapter registered for this exact action/target. **The application installs no external publication adapters. This endpoint therefore fails closed. Production execution is explicitly unavailable even if an adapter is supplied.**

All mutations use strict schemas. Missing identity, foreign owner/issue, changed candidate/SHA/scope/environment, new revision/attempt, expired/revoked approval or expired/signed-out approval session fail before an effect. A successful approval is not permission to merge, deploy another environment or reuse another action.

## Gates, provenance and single consumption

Approval requires the latest execute/review/verify attempts for this candidate to be passed, with three distinct persisted run and session IDs. Each evidence reference must match that attempt, candidate SHA and environment, and resolve to an actual succeeded same-owner/same-issue run report or chunk with start/finish timestamps. Execute additionally checks the persisted submitted result, verify status and exact published candidate commit. #193 remains responsible for the independent conclusions and actual verification, including raw command/exit-code logs. The frozen report schema does not guarantee an exit-code field; #194 does not invent one.

Screenshots/videos/arbitrary URLs are refused because the frozen baseline has no trusted artifact reader for those kinds. A future reader must be coordinated with #193 and existing access-controlled storage before these artifacts can support approval. There are no manufactured screenshots or recordings.

The approval gate only accepts the server-created ledger ID, original approved revision and attempt, live human identity and unchanged evidence digest. It records the exact subsequent publish attempt/revision. The publish gate accepts a persisted successful receipt for that approval, action, target and fence; a caller-supplied receipt cannot pass it.

A durable publication reservation commits **before** invoking an adapter. A unique `(taskId,candidateId,action,target)` and unique approval ID permit at most one invocation. The task lock and all fences are reacquired before execution and held through the receipt/gate transaction. Concurrent cancellation or revocation cannot slip between the final task fence and invocation. Exact completed replays return the recorded receipt only while the current candidate/attempt and human grant remain valid. Reserved, uncertain, expired or superseded requests never invoke the adapter again.

External effects and PostgreSQL cannot be made atomically exactly-once by a local transaction. If execution throws, the process crashes, or receipt/state persistence fails after an effect, the durable reservation remains `reserved` or becomes `uncertain`. It is not automatically retried. Operators must inspect the target outcome using the reservation's idempotency key; this candidate provides no retry/reset API. An uncertain outcome never passes the Factory publish stage.

## Reproducible local checks and remaining acceptance

Run only against a disposable loopback PostgreSQL 17 database named `mikka_e2e`. The tests apply all migrations into random schemas and remove those schemas afterward. A loopback-only Docker example:

```sh
docker run -d --name mikka-194-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=mikka_e2e -p 127.0.0.1:55434:5432 postgres:17
FACTORY_LOCAL_DB_TESTS=1 \
  E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:55434/mikka_e2e \
  node --import tsx --test lib/factory/contract.test.ts \
  lib/factory/postgres.test.ts lib/factory/approval.test.ts
node --test scripts/check-migrations.test.mjs scripts/migration-order.test.mjs
node scripts/check-migrations.mjs
```

These checks exercise real SQL locks/rollback/reconnect, browser HTTP with real Better Auth signed cookies/sign-out, and an actual isolated temporary filesystem effect. They cover 10-way approval/publication contention, missing/expired/revoked/wrong grants, original artifact readback, failure/repair/new-candidate fences and an effect followed by SQL rollback. **Users, OAuth account links and #193 results are explicit fixtures. The filesystem adapter is only in the test. These checks do not prove human OAuth approval, actual CC/Codex review/verification, a Preview deployment or target publication.**

Completion remains blocked on #193's trusted integrated gates and real run/session/command/exit-code artifacts; a real human OAuth session approving the frozen evidence; and an expressly approved controlled nonproduction target with its trusted adapter. The parent batch's Preview deployment was denied by approval review and its user request is pending. No retry, alternative deployment path or production publish is performed here. #181 same-version acceptance and independent review remain outstanding. No issue closure or merge is requested.
