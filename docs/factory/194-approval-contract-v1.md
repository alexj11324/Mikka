# Factory #194 approval/publish consumer v1

Base: coordinated #191+#192 `7e93b86277fbfeb1a5f19d41bcc0c03596484491`, with coordinator-supplied #194 filename compatibility `4d6f83c43639a26380e4cdc1587ce52ac0a5f4d9`. This preserves the earlier `4cd3a1b5` / frozen PR197 `605bf086` ancestry. The [#192 contract](192-contract-v1.md) and `lib/factory/contract.ts` are unchanged. `createFactoryApprovals` uses `createFactoryStore(pool, authorize, gates)` and its existing `read/apply` transaction boundary. There is no second stage source, scheduler, Harness or worker permission system.

## Dependencies and installation

`lib/factory/server.ts` installs only `approvalGate` and `publishGate`. #193 must compose its own review/verify gates into that same store. They are absent on this candidate and remain closed. #194 never promotes executor self-report into an independent result. Existing daemon candidate commit/push is unchanged: it precedes candidate review and is not a merge/deployment approval. The concrete upstream rows and evidence requirements are in [the #193 handoff](194-upstream-evidence.md).

Migrations: #192 `20261026190326_factory_192_stages.sql`, imported #191 `20261026190325_run_dispatch_keys.sql`, new #194 `20261026190327_factory_194_approvals.sql`. The obsolete `20261025004500`, `20261025011101`, `20261025011347`, `20261025010001` and `20261025012001` candidate filenames are absent. The new migration is reentrant and adds consumer ledgers only.

## Browser API

`/api/factory/tasks/:taskId/approval` uses the existing Better Auth browser session. Authorization headers (including MCP OAuth, worker and daemon credentials) are rejected. JSON cannot select an actor. The adapter disables cookie-cache lookup; transactions also recheck the actual unexpired session and linked Google/GitHub account, task owner and current issue access. An account link is an authentication prerequisite, not proof that a human has performed this acceptance run.

- `GET`: read the fixed candidate evidence inventory. Returns the full #192 binding, exact candidate identity, artifact hashes and original run/session/time provenance, evidence digest for display. This GET does not write a read receipt.
- `GET ?artifact=run-report:UUID` or `run-chunk:UUID`: read an inventory artifact back from existing access-controlled storage. Known credential fields/formats are redacted in the response. The hash refers to the original source; raw contents are never copied to the approval ledger. Redaction is defense in depth, not a certification of arbitrary producer output.
- `GET ?view=ledger`: read the human approval and publication history without browser session tokens.
- `POST {operation:"accept",input:{binding,eventId}}` (#528): a code candidate's acceptance. The server merges the candidate PR as the accepting person, with their own GitHub user token and GitHub's `sha` parameter set to the candidate commit; the task completes on that merge or on the merged webhook. `200 {status:"merged"}`, `202 {status:"merging"}` (outcome not yet known; never merged twice), or `409 {error:<githubMerge… code>,pullRequestUrl}` with the task still waiting. See `docs/factory/warp-aligned-factory.md`.
- Skill candidates only in production (a code candidate gets `factoryAcceptanceIsMerge`; the composition sets `codeCandidatesMerge`): `POST {operation:"approve",input:{binding,eventId,candidate,action,target,targetEnvironment,expiresAt}}`: same-origin cookie operation. `candidate` has exact `sha/repository/environment/scope`. `action` is `deploy_preview`, `deploy_production` or `merge`; `target` is the exact registered target identifier; `targetEnvironment` is its separately approved destination. The immutable candidate environment may be a #193 device identity. Expiry must be in the next 24 hours. No prior evidence read is required. Old clients may still send evidenceDigest/evidenceReadId; they are compatibility fields, not human approval conditions. Approval binds the current candidate and SHA; changing display evidence does not invalidate it. Approval finish and advancement to the single existing publish attempt occur atomically with the approval ledger.
- `POST {operation:"revoke",input:{binding,eventId,approvalId}}`: revoke with the current fence. An append-only control event records the authenticated user/session and exact payload; changed replay payloads are rejected.
- `POST {operation:"publish",input:{binding,eventId,approvalId,action,target,targetEnvironment}}`: execute only a trusted backend adapter registered for this exact action/target. **The application installs no external publication adapters. Production execution is explicitly unavailable even if an adapter is supplied.** An explicitly enabled loopback local-artifact adapter is available for controlled local gate acceptance; its receipt is visibly `local-artifact`, and is never a cloud deployment receipt. See [adapter wiring](194-nonproduction-adapter.md) and the [#195 receipt handoff](194-195-publication-handoff.md).

All mutations use strict schemas. Missing identity, foreign owner/issue, changed candidate/SHA/scope/environment, new revision/attempt, expired/revoked approval or expired/signed-out approval session fail before an effect. A successful approval is not permission to merge, deploy another environment or reuse another action.

## Gates, provenance and single consumption

Approval requires the latest execute/review/verify attempts for this candidate to be passed, with three distinct persisted run and session IDs. Each evidence reference must match that attempt, candidate SHA and environment, and resolve to an actual succeeded same-owner/same-issue run report or chunk with start/finish timestamps. Execute additionally checks the persisted submitted result, verify status and exact published candidate commit. #193 remains responsible for the independent conclusions and actual verification, including raw command/exit-code logs. Frozen #193 PR199 now supplies actual `report.verify.exitCode/signal/timedOut` plus verifier tool chunks; see the exact upstream handoff. #194 reads these sources without inventing results.

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
  lib/factory/postgres.test.ts lib/factory/approval.test.ts lib/factory/local-publication.test.ts
node --test scripts/check-migrations.test.mjs scripts/migration-order.test.mjs
node scripts/check-migrations.mjs
```

These checks exercise real SQL locks/rollback/reconnect, browser HTTP with real Better Auth signed cookies/sign-out, and the concrete local adapter's immutable target write and exact-candidate readback. They cover 10-way approval/publication contention, missing/expired/revoked/wrong grants, original artifact readback, failure/repair/new-candidate fences and an effect followed by SQL rollback. **Users, OAuth account links and #193 results are explicit fixtures. These checks prove controlled local artifact publication, not human OAuth approval, actual CC/Codex review/verification or a Preview deployment.**

Completion remains blocked on #193's trusted integrated gates and real run/session/command/exit-code artifacts; a real human OAuth session approving the frozen evidence; and an expressly approved controlled nonproduction target with its trusted adapter. The parent batch's Preview deployment was denied by approval review and its user request is pending. No retry, alternative deployment path or production publish is performed here. #181 same-version acceptance and independent review remain outstanding. No issue closure or merge is requested.
