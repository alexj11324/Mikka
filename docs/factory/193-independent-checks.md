# Factory independent checks (#193)

This increment is based on current main and selectively restores #193. PR #316 remains separate and unmerged. It does not replace current host message policy, Agent Kit snapshots, subscriptions, mailbox transport or native Coordinator behavior.

## Runtime receipt

Existing `acceptance` assignments with an exact 40-character `baseBranch` and the existing `readOnly` policy produce daemon-owned `report.check = { sha, readOnly: true }`. The daemon pins Git operations to the real worktree Git directory and checks clean, unchanged HEAD before the Harness and around verification. Read-only runs skip writable setup and the existing publisher. The existing verify process supplies `verify.command/exitCode/signal/timedOut/output`; model handoff data cannot provide this receipt. Reports lacking it cannot establish Factory verification.

The shared report shape is additive and optional for existing non-Factory consumers. It does not introduce another run kind, verifier, publisher or permission system.

## Executable question ancestry contract v2

`lib/factory/check-independence.ts` exports an actual read-only predicate and `FACTORY_CHECK_ANCESTRY_CONTRACT_VERSION = 2`:

```ts
factoryCheckIndependent(
  tx: Pick<PoolClient, "query">,
  task: FactoryCheckTaskIdentity,
  runId: string,
): Promise<boolean>
```

`FactoryCheckTaskIdentity` projects only `id/userId/issueId/sourceEventId/stage/status/attemptId/candidateId`. Existing #192 task values are structurally assignable. The projection neither owns state nor defines another stage enum/schema; the function reads the existing attempt/run/question rows through the caller's transaction. Callers must already hold an authorized current-task lock and validate the frozen check assignment. This predicate does not reauthorize a user or validate a daemon report.

Example trusted consumer call, for either a successful or failed completed check:

```ts
const independent = await factoryCheckIndependent(tx, currentTask, currentRun.id);
if (!independent) {
  // Reject provenance through the existing blocked/denial path.
}
// Continue the SAME consumer's receipt/result validation. true does not mean passed.
```

V2 supports **review, verify and monitor**, following the explicit coordinated monitor extension. The same strict ancestry rules apply to successful and failed results in every supported phase. Execute/approval/publish still return false. This predicate does not install or replace the #195 monitor business gate, target receipt checks, permissions or approval. Frozen v1 at `3ee0c745a99aba6c65c64a06007197a375a3d1a2` remains review/verify-only. For valid question continuations, the entire same-owner/issue/task/candidate/phase/session origin chain must match durable resolved questions, accepted answers and exact attempt/run/revision fences. All original #235 ancestry comparisons are retained; the authorized monitor stage is the only runtime-condition extension. The structural TypeScript projection stays independent of unavailable foundation imports and introduces no state owner.

`pnpm test:factory-check-independence` runs pure persisted-row fixtures for success and failure, multi-hop continuation, cross-identity/phase/session/SHA reuse, cancellation/revocation, missing metadata/answers, arbitrary retries and cycles. They execute the real predicate against a synthetic SELECT adapter; they do not prove actual PostgreSQL, claim transactions, authorization or a provider run. Normal CI runs this pure contract. The required DB inventory also runs `test:factory-check-independence-db` against its existing Actions-only loopback PG17 service, with no skip/application-URL fallback.

## Consumer handoff to #192 / #194 / #195

The consumer increment depends on #192's single task/attempt/candidate store and authenticated `route/read/apply` transaction. Required identities are owner, issue, task, attempt, revision and exact candidate SHA/repository/environment/scope. The store must recheck current issue access, cancellation and revocation before mutation or replay. A device-loss retry stays unclaimable until its existing adoption contract binds it to the current attempt.

#193's consumer functions retain these established interfaces:

- `configureFactoryCheck(tx, task, runId)` freezes the read-only SHA, command and repository/device in the current attempt before transactional binding.
- `factoryCheckAssignment(tx, userId, runId)` supplies the frozen review/verify assignment to #192's existing `createFactoryClaim(store, questions, validateCheck)`. Task/access/run locks, retry-lineage checks and token issuance remain in that single claim path; this increment adds no separate claim transaction. Unbound retry descendants cannot enter the ordinary claim path.
- `factoryCheckGates.review/verify` require the daemon receipt and persisted current-run evidence. Verification also requires paired actual verifier input/output chunks for the frozen command.
- `reconcileFactoryCheck(tx, store, task, run)` uses the existing Coordinator transaction and retains original command/exit/report/chunk evidence on failure. It does not choose recovery or open an executor automatically. New candidates require fresh review and verification.
- `factoryRepairBrief(tx, task, runId)` forwards the original failed attempt and artifact references to that repair run.

These callbacks need the existing dispatch/reconciliation/claim transaction seams; no separate scheduler or stage source is introduced. Approval, publication and monitoring adapters belong to their existing owners and are not installed here.

The executable consumers now use frozen #192 lifecycle source `12c7c50f66703de66c6e4e67344880ee3fb20a56`. Its actual signature is `createFactoryStore(pool, authorize, botId = null, lifecycle?)`: Bot identity is third, lifecycle is fourth. `factoryRuntimeForBot` installs the review/verify gates, configurators, assignment checker and completion consumers by default only behind the two existing default-off flags. Execute configuration appends the original failed attempt's bounded repair brief before the existing frozen definition is captured. Monitor independence remains available to #195; its target/probe/configurator/gate is not installed by #193. Missing monitor configuration still fails closed.

Only the coordinated `20261028182316_factory_192_routing.sql` and `20261028182317_factory_192_questions.sql` are inherited; the old `070000` name is absent. This code integration neither applies production SQL nor enables either flag. The source contract itself supplies no production authority.

The final #235 same-phase question ancestry rule (`d4e7da9` plus correction `0341837`) is preserved. Only exact resolved question ancestors in the same owner/issue/task/candidate/phase/session chain may share a session; every run remains distinct. Each edge binds the waiting attempt/revision, original run/session and persisted continuation result to the new attempt. Arbitrary retries, foreign or cancelled/revoked ancestry and cross-phase/candidate/session reuse remain rejected. Do not combine this predicate with the older blanket rejection of every historical same-session attempt.

For #194, the latest passed execute/review/verify attempts retain distinct run/session identities. Evidence references are the original `run-report:<runId>` and `run-chunk:<chunkId>` artifacts with the frozen candidate SHA/environment and truthful recorded/source times. Original waiting question attempts do not replace the current continuation's completion artifacts. #193 grants no publication or monitoring authority.

## Validation boundary

The daemon regression uses real Git worktrees and child commands with an explicitly simulated Harness. It records an actual failing command/exit 17, then a new commit and separate check sessions with exit 0. This is process-layer evidence, not real CC/Codex acceptance or a model-quality evaluation. Existing sandbox and deployment restrictions remain in effect. The reader-contract PG/HTTP tests described below run in authorized CI. Complete production-store/dispatch/claim integration still requires the matching #192 foundation; provider/fixed-deployment acceptance and any actual interface capture remain separate release gates. No live model evaluation is enabled by this increment.

## Actual isolated PG/HTTP consumer contract

`lib/factory/check-independence.db.test.ts` creates a random schema inside the existing authorized GitHub Actions `127.0.0.1:5432/mikka_e2e` PG17 service. It refuses all application/cloud URLs, missing isolation flags or mismatched configured targets. Its synthetic tables project exactly the rows read by this predicate; they are test fixtures, not a #192 migration or alternative Factory implementation. They are retained until the existing CI service teardown, with no application-table change or manual DROP.

A real loopback HTTP fixture consumer holds the task/permission/run transaction fences and calls the actual exported function over real PostgreSQL joins/JSON/timestamp values. It covers all three phases and terminal outcomes, multiple questions, concurrent deterministic consumption, cross-owner/task/candidate/phase/session/origin/revision/answer/metadata/retry denial, and a cancellation or permission revocation winning actual PostgreSQL row-lock contention. A valid failed observation remains failed; the function never promotes a task or grants a business result.

The actor/assignment records and outcomes are explicitly synthetic. This proves the reader and HTTP consumption contract under those fences, not actual OAuth authentication, Mikka dispatch/claim/token routes, #195 business/probe validation, a provider run or a deployment. Those integrations remain with their existing owners and must be accepted against their real implementations. No provider is executed here.

`test:factory-checks-db` additionally applies the actual tracked migrations to a random retained database inside the same existing Actions-only PG17 service and exercises the real store, dispatch, questions, claim, local claim/token transaction hook, gates and reconciler. Actual loopback HTTP calls use #192's real question handler. Queue inputs, browser actor, terminal daemon reports, model-origin attestations and token-hash rows are explicitly synthetic fixtures; there is no provider call, live OAuth session or usable credential. The suite checks independent review→verify→approval, trusted same-session question continuation for both outcomes in both check phases, original failure/exit/artifact handoff after model-selected recovery, forged or missing receipts/chunks, retry/cancel/access denials before token hooks, and the shared recovery budget. Mandatory DB inventory and the normal CI enforce no skips. A passing fixture chain does not prove real CC/Codex resume, vision-model judgment or production deployment acceptance.

The migrated consumer suite owns a separate random database on the existing disposable service because PostgreSQL extensions are database-wide. It does not install extensions into a schema shared with other suites, create an external resource, copy credentials or delete the test database. This isolation also prevents its retained fixtures from changing later suites' extension search paths.

## Model-owned recovery judgment v1

`createFactoryCheckRecovery(pool, store)` returns `(userId, input, hostJudge, existingTx?) => Promise<FactorySnapshot>`. The model input is strictly `{binding, choice: 'retry_check' | 'repair_code', rationale}`. A host-injected `FactoryRecoveryJudge` supplies `executionId/modelId/vision: 'verified'`; `callId` comes from the existing SDK invocation. Model-supplied identity, vision and permission fields are rejected. The registered `recover_factory_check` tool reuses native scope checks, Agent Kit instrumentation and immutable tool grants, and the existing default-off lifecycle runtime. No existing snapshot acquires a new grant.

The model assesses original failure evidence and chooses recovery. Same-SHA retries are allowed through a fresh attempt/run/session. A source edit/new commit is not universally required. Mechanical checks preserve task/access/cancellation, immutable failed receipt/candidate/session provenance, exact replay and the configured shared recovery/execute budgets. Decisions and new-attempt context use the existing `factory_events` and attempt output; the original finished attempt is unchanged. Valid recorded timeout observations can be retried after model choice without changing source. Unknown or corrupted provenance remains closed, without adding a blanket human-confirmation step.

The current host `NativeToolScope` and `HostedRuntimeSnapshot` do not expose verified visual capability or actual image-input provenance. `CoordinatorToolOptions.factoryRecoveryJudge` is the explicit host integration seam; absent a real matching execution and verified vision-model context, recovery returns `factoryVisionModelProvenanceRequired`. No model-name heuristic or self-report fills that gap. Visual tasks must receive actual images through existing granted tools. Real host model-selection/image transport and provider acceptance remain pending and are not proved by synthetic model-origin tests. #192's question decision/context policy and #194's authorization implementation remain with those owners.

`configureFactoryCheck(tx, task, runId, hostPolicy = defaultRunPolicy())` freezes the existing canonical `applyApprovalMode(hostPolicy, 'read_only')` policy. Network allow/ask/deny and its domain list are retained, rather than replaced by a Factory-wide empty-list/ask rule. The actual claim tests cover all three choices. Read-only write/push/dependency constraints remain in the shared policy; #193 does not change them. The shared `READ_ONLY_DENIED` also currently includes `run_project_script`, while verify requires original model tool execution of the frozen command. That real Harness contract needs coordinated acceptance; a mock command trace cannot resolve it and isolation is not weakened here.

`test:factory-check-recovery` exercises the real registered tool adapter: host execution/model matching, SDK call identity, rejection of forged model-supplied capability/permission fields and unchanged frozen grants. The migrated PG suite uses synthetic model-origin fixtures for the decision input. It proves that the same recorded timeout can follow either explicit model-selected action, not that a real vision model performed that judgment. CI/default-off/library registration alone do not complete Factory functional acceptance; merge/deploy remain on hold while the actual model/image/Harness path is unverified.
