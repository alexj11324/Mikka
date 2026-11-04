# Fixed failed group Factory diagnostic — prepared only

This candidate is inert under scripts/ops/acceptance-prepared. An authorized operator must review and replace the existing temporary branch's single .github/workflows/proactive-acceptance.yml to execute it. No workflow, database call, application session, provider inference, or cleanup has been started by preparing these files.

## Exact scope

Original core run 41778455749 used source 62bb445860642cb110b37e00794daf06ab454f88 and dpl_419jqfp1pAwM8QJY2Bt1if7sbH2t. The group create route completed four genuine Decision requests, then the generic group failure path reported generation_failed_not_replayed. That name does not establish a text-generation failure: the delegate route invokes the host Factory adapter without a normal chat generator. Missing final delegate receipts do not exclude an earlier admitted run or allocated machine.

Readback is pinned separately to current source 7b6c1ee1b4a53563b2d6d9885ad992858514cd7a and dpl_EJC6ev9gDootduhzSggG6YLd2Udi. The deployment's READY state and githubCommitSha were independently read through the existing 612 Vercel connector. The diagnostic also checks normal public /api/version before and after the snapshot.

Only the fixed original requester, workspace, group, create message, and Coding reporter in TARGET are accepted. Each SELECT repeats the same scope CTE verifying conversation creator/workspace/kind, root user message ownership, and reporter ownership/workspace. Derived intake/delegation event IDs use the exact fixed application's factoryEventId algorithm; no model text or request-controlled IDs provide authority.

## Database and output boundaries

The existing OIDC identity reads only prod:/vercel / MIKKA_DATABASE_URL, the same named path successfully observed by metadata workflow 41770686098. No new grant, different account, connection export, DSN logging, or secret file is introduced. The value is used in memory by one pg Client from the pinned source dependency and removed from this process environment. It is not transformed into a new direct endpoint.

One REPEATABLE READ READ ONLY transaction verifies transaction_read_only=on and sets a 10-second statement timeout, 5-second lock timeout, and 30-second idle transaction timeout. The client has 10-second connection and 11-second query limits. A SQL error stops immediately; there is no read retry. ROLLBACK and connection.end run in finally. A workflow rerun is rejected and a local O_EXCL start marker prevents duplicate invocation in the same job.

Nine fixed queries observe:

1. The exact turn status, limited error code, routing action/operation/timing, and count of saved Decision steps.
2. Its pending/final task receipt and typed task/run/epoch IDs.
3. Its exact group Task binding and execution/reporter owners.
4. The two deterministic host event IDs and any attached issue IDs.
5. Only Factory tasks associated with those host issue references and this owner/reporter.
6. Their attempts, stage/status, run IDs and explicitly projected requestEpoch.
7. Their owner/reporter/issue-bound runs and devices.
8. Their owner/workspace/reporter-bound thread machines.
9. The exact new reporter's runtime plus its owner's shared desktop state.

Each query has a LIMIT (1–30). No message body, role, prompt, task reason, run error text, event payload, full attempt output, agentDefinition, token, credential, URL, process log, or machine log is read. Unknown error/status text is projected to null; only known codes, typed IDs, timestamps, booleans and bounded integer counts are output. SQL failures expose only a finite SQLSTATE allowlist and the host query name.

A shared desktop row is only an ownership observation. It does not prove that this fixture created it and must not authorize cleanup. A missing receipt, missing Task, or failed diagnostic does not prove resource absence. This script never cancels a Task or ends a machine. Any cleanup must separately use the normal owner API after exact Task/epoch/run/frozen-identity confirmation.

## Verification

Pure Node contracts: 7 passed, 0 skipped (source scope, read-only ordering and fixed queries, timeout with no retry, owner rejection, no private output, deployment drift and connection-close failure). node --check passed. These are offline contracts, not a claim that production or a PostgreSQL instance was queried.

Separately, all nine exact parameterized SELECT statements passed EXPLAIN (FORMAT JSON) on the existing isolated PostgreSQL E2E database in one READ ONLY transaction with a 10-second statement timeout. Command cmd_9f14d6631251498e99c168a0118d exited 0 (107 ms). This verifies SQL parsing, relation/column names and parameter types against migrated PostgreSQL; it is not a production observation, does not execute provider work, and does not claim the fixed production rows exist.

The 10-minute job installs the pinned source dependency before reading the secret. The actual readback step is capped at 3 minutes. Upload includes only the sanitized results.json, not the secret, start marker, source checkout, or environment.

