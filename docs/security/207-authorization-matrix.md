# Issue 207: server authorization coverage and worker boundary

Baseline: main `8f8484ff3bf9a55f5c759d7e2316ab90c5fb854f`, 2026-10-25 UTC.
No repository SECURITY.md was present. Existing role/access code and issue 207 define this scope; no new IAM policy is introduced.

## Candidate deduplication

- #169 `1cc27501486676b312adb1cf1a76ee4ab6298aa1`: task visibility and safe run metadata, shared issue access predicates. Reuse `issueForUser`; do not duplicate its scope policy.
- #170 `3113c3d07a543c189a82f8b9112c5158e46f5e64`: search/pagination, stacked on #169. Not in main.
- #197 `605bf086d4371e19f2df2e2857a487f1decd649d`: Factory stages/dispatch fences. Not in main; parallel Factory files remain untouched.
- None of these candidates changes `lib/mcp/worker.ts`.

## Entry matrix (source review, not exhaustive runtime acceptance)

| Entry/resource/action | Trusted actor and current control | Coverage / remaining gap |
| --- | --- | --- |
| Workspace settings and membership mutations | Session user; `requireWorkspace`, active membership, admin for admin actions | Existing role model; workspace ID alone grants nothing. End-to-end role matrix still required. |
| Task detail and queue dispatch | Session/OAuth/coordinator-bound user; `issueForUser` / `queueRun` | #169 owns visibility consistency. Dispatch checks at queue time do not establish execution-time authority. |
| Task list, relations, search and run metadata | Owner/member predicates on main; #169/#170 strengthen shared predicates and SQL filtering | Re-test combined tree; do not infer candidate coverage is shipped. |
| Worker MCP report / ask / blocked | Opaque run-token hash; matching run owner; expiry/revocation/live-state checks | This PR tests current issue access, stop request and orphan denial, at request authentication and before event insertion. |
| Daemon claim / run events / completion / checkpoint | Device bearer and owned device/run (`app/v1/...`) | Claim lacks fresh issue-access check on baseline; daemon handling and actual process stop remain separate work. |
| Coordinator durable steps and third-party actions | Bound user ID, issue check for dispatch; owner-only personal integrations | No global workspace policy assumed; every long-lived external action needs separate policy/side-effect review. |
| Private Agent sessions and turns | Session user plus `agent-store` owner and attempt predicates | Workspace membership does not grant access. No UI/session code changed. |
| Group messages/membership | Session user, group membership and workspace active-user eligibility (`group-conversations-route/store`) | Keep explicit group membership boundary; workspace member alone is insufficient. |
| Pending integration approvals | Session/owner-bound proposal, action allowlist and TTL | Actual approval execution and revocation races outside this slice. |
| Artifact/file URLs and caches | Not established by this review | Requires provenance, signed URL lifetime, cache key, count and pagination tests; not covered by a workspace field. |

## Runtime and production handoff

The regression uses the existing CI disposable PG17 `mikka_e2e` and built Next HTTP `/mikka/api/mcp`, with two workspace links and synthetic users, issues, agents, runs and tokens. Tokens stay in process memory; only hashes enter the fixture database. No real credentials or production records are used. Fixtures are inserted/updated, never deleted by this test.

Assertions cover owner/admin and member success; another workspace denial; personal owner success; missing issue denial; suspension after running/queueing; continued access for the unaffected owner; stop-request denial; explicit token revocation; Coordinator-event DB readback. A seeded foreign-workspace run is defense-in-depth, not a claim that queueRun can create it normally.

The policy check follows the authoritative issue link, not an input workspaceId. It uses both application and workspace database adapters (these share the isolated CI database, but may be separate in deployment). The final gate holds the existing relation-writer advisory lock in shared mode, workspace link/membership read locks and app issue/member/run/token read locks through the app event commit. Both policy helpers receive the held executors; no additional pool connection is borrowed inside the scopes. Concurrent revocation either commits before this gate and is denied, or waits for the already-authorized event to commit and then denies later requests. Locks have bounded timeouts; run is locked before token, and token expiry is checked again after lock acquisition. This is normal-connection ordering, not distributed two-phase commit: losing the workspace connection can release its locks before the app commit; an app commit followed by workspace COMMIT failure cannot undo the event and may suppress wake or cause duplicate retry events. Cross-database connection-failure atomicity and global process-stop SLA remain open, and require a separately designed failure protocol. No zero-latency global revocation is claimed.

Parent acceptance gates:

1. Independently review the diff and re-run against the combined #169/Factory tree, especially personal ownership semantics.
2. Freeze candidate SHA, matching migrations and unique authorized Preview URL. Reuse authorized OAuth sessions and two synthetic workspaces; do not inspect real customer records.
3. Queue and run actual supported Harness work as owner/member; suspend member before the next tool request. Prove MCP denial and unchanged event counts; preserve the unaffected workspace success case. Exercise report, ask and blocked separately.
4. Verify daemon claim/execution/retry gates with the daemon owner; worker rejection alone does not prove local execution stops. Record cross-database connection-failure atomicity as an explicit remaining boundary.
5. Parent coordinates production deployment and repeats the authorized real-user flow. Record UTC, exact service/daemon SHA, environment, synthetic IDs, HTTP outcome and DB readback; upload a redacted video to PR #225. API/CI fixtures are not production acceptance.

Keep issue 207 and this draft open until the broader matrix and production gates are satisfied.

## Impact discipline

The concrete worker sink is a Coordinator inbox event (report/question/blocked), not arbitrary tool execution or a read of another tenant’s task body. The foreign-run fixture is a negative authorization control; queue-time reachability must not be inferred from that seed. A revoked member may remain an authenticated product user; the authority being withdrawn is access to the linked task. This slice does not claim all P0 gaps are fixed.

## Independent review and deterministic regression

An independent read-only reviewer rejected the first recheck-only candidate for the final SELECT-to-INSERT window. The revised lock protocol incorporates its pool-exhaustion, run-before-token lock ordering and post-lock token-expiry findings. Final approval remains conditional on exact-head real tests, not just source review. The fourth app executor parameter follows #197’s existing helper shape; the fifth workspace executor must also be preserved when integrating #169 visibility helpers.

The HTTP regression runs with Playwright’s existing single-worker serial configuration and CI gateway wake disabled; its PG authentication-query marker relies on that isolation and must be strengthened before parallelizing the suite. It withholds the request body, observes completed authentication SQL in pg_stat_activity, commits suspension and then sends the body; both queued and running tools must return an MCP error without an event. Unique fixture-only BEFORE INSERT triggers pause the actual event INSERT using advisory locks; concurrent membership/stop/token revocations must be observed waiting for the authorized event transaction, then later calls must return 401. Six simultaneous authorized requests exercise both max-five pools. Trigger definitions affect only their synthetic run and remain in the disposable test database; the test issues no DROP/DELETE.

## Parent production video script (not yet executed)

- Record the fixed deployment URL, service SHA, daemon SHA and UTC on a clean recording surface; hide headers, tokens, cookies, private prompts and unrelated account data.
- Read-only first: confirm the deployed SHA and existing session/workspace context. Use only designated synthetic workspaces and users; never enumerate customer tasks or credentials.
- Through existing authorized UI/API, create or reuse two controlled workspaces, owners/members and benign no-external-action Harness tasks. Keep all fixture records; cleanup deletion requires separate approval.
- Record owner/member successful tool results, then an admin suspends the designated member. Record that same run/token’s next report/ask/blocked call fails and read back an unchanged count of worker-originated run_report/run_question/run_blocked events, while workspace B still succeeds. Do not count legitimate daemon completion/cleanup events as worker-tool writes. Show queued and running cases separately. Tokens remain in the approved client’s memory/configuration and are never displayed.
- Show a stop request followed by worker rejection. Verify actual daemon stop/claim behavior with its owner separately; worker rejection is not proof a local process stopped.
- Record failure cases and observed timings without editing them out. Upload only the redacted production video to PR225, with safe synthetic IDs, exact version and pass/fail notes. No production SQL triggers, backend termination, schema changes or fault injection are authorized by this script; deterministic faults stay in the isolated test environment.
