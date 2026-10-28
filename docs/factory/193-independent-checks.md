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

The daemon regression uses real Git worktrees and child commands with an explicitly simulated Harness. It records an actual failing command/exit 17, then a new commit and separate check sessions with exit 0. This is process-layer evidence, not real CC/Codex acceptance or a model-quality evaluation. Existing sandbox and deployment restrictions remain in effect. The reader-contract PG/HTTP tests described below run in authorized CI. The matching #192 foundation is now consumed by the migrated store/dispatch/claim suite below; provider/fixed-deployment acceptance and any actual interface capture remain separate release gates. No live model evaluation is enabled by this increment.

## Actual isolated PG/HTTP consumer contract

`lib/factory/check-independence.db.test.ts` creates a random schema inside the existing authorized GitHub Actions `127.0.0.1:5432/mikka_e2e` PG17 service. It refuses all application/cloud URLs, missing isolation flags or mismatched configured targets. Its synthetic tables project exactly the rows read by this predicate; they are test fixtures, not a #192 migration or alternative Factory implementation. They are retained until the existing CI service teardown, with no application-table change or manual DROP.

A real loopback HTTP fixture consumer holds the task/permission/run transaction fences and calls the actual exported function over real PostgreSQL joins/JSON/timestamp values. It covers all three phases and terminal outcomes, multiple questions, concurrent deterministic consumption, cross-owner/task/candidate/phase/session/origin/revision/answer/metadata/retry denial, and a cancellation or permission revocation winning actual PostgreSQL row-lock contention. A valid failed observation remains failed; the function never promotes a task or grants a business result.

The actor/assignment records and outcomes are explicitly synthetic. This proves the reader and HTTP consumption contract under those fences, not actual OAuth authentication, Mikka dispatch/claim/token routes, #195 business/probe validation, a provider run or a deployment. Those integrations remain with their existing owners and must be accepted against their real implementations. No provider is executed here.

`test:factory-checks-db` additionally applies the actual tracked migrations to a random retained database inside the same existing Actions-only PG17 service and exercises the real store, dispatch, questions, claim, local claim/token transaction hook, gates and reconciler. Actual loopback HTTP calls use #192's real question handler. Queue inputs, browser actor, terminal daemon reports, model-origin attestations and token-hash rows are explicitly synthetic fixtures; there is no provider call, live OAuth session or usable credential. The suite checks independent review→verify→approval, trusted same-session question continuation for both outcomes in both check phases, original failure/exit/artifact handoff after model-selected recovery, forged or missing receipts/chunks, retry/cancel/access denials before token hooks, and the shared recovery budget. Mandatory DB inventory and the normal CI enforce no skips. A passing fixture chain does not prove real CC/Codex resume, vision-model judgment or production deployment acceptance.

The migrated consumer suite owns a separate random database on the existing disposable service because PostgreSQL extensions are database-wide. It does not install extensions into a schema shared with other suites, create an external resource, copy credentials or delete the test database. This isolation also prevents its retained fixtures from changing later suites' extension search paths.

## Model-owned recovery judgment v2

The two shared #331 files were materialized verbatim from author commit `bb2a582498c95dcf13e57739e7e0ed866c0e190f` (tree `67490437339f2d22d3dd194b2f4ea0e982bc3d90`). Their SHA256 values are `a6927c2721b09a97bace4f652c2224a60d5d579cad44bb1d322311122d367c16` for `lib/coordinator/decide.ts` and `a74bea999aceb37dff95e8d0220647be2fd277b84c730e4e72bd8cc1cd063622` for `lib/coordinator/decision.ts`. This consumes those exact exports in this isolated candidate, not the other 25 paths or another owner's branch.

`createFactoryCheckRecovery(pool, store, dependencies?)` returns `(userId, {binding}, sdkToolCallId?, signal?) => Promise<FactorySnapshot | {pending:true, reason, binding}>`. Defaults call the actual shared `invokeDecision('factory-check-recovery', context, questions, signal)`. The planning tool supplies only the current binding; it cannot supply choice, rationale, pixels, model identity, execution receipt or permission. `invokeDecision().answers` is the actual typed Map. Its `recovery` choice selects `retry_check`, `repair_code` or `defer`, without a confidence threshold or a fixed error-text classifier. A missing/refused/invalid answer leaves the existing failed/blocked observation pending. No new executor or new commit is universally required.

The registered `recover_factory_check` tool uses the existing native scope/Agent Kit/frozen grant path. SDK call identity comes only from that tool's context; the Decisions REST call does not create one. `FactoryRecoveryJudge`, `vision=verified` and the provisional caller assertion have been removed. The actual host `DecisionExecution` binds execution/model/provider-generation identity, UTC timing, exact request digest and ordered image-byte digests. Its `image-input-submitted` marker records submission only, never visual understanding. A text observation records `no-image-input`.

The consumer first reauthorizes and checks completed replay before any inference. A short existing-event reservation bounds duplicate/concurrent invocation and retry count, with a ten-second lease; task/attempt/candidate remain the only stage source. All clients and transactions are released before the model call. Afterward it reacquires the task/access fence, rechecks the exact binding/original observation, validates request/receipt/image digests and current pixels, and atomically applies the model-selected existing retry/repair transition. Cancellation, lost access, changed state, stale invocation and budgets still reject. A completed replay returns its original result without reinference or a fresh generation-ID conflict. The original finished attempt is unchanged.

Host `collectImages` dependencies may read actual owned artifacts through local/DB readers. Each image binds artifact/run/session/candidate/SHA/observation time; pixels and provenance are rechecked before application. Required missing or mismatched images retain pending, without text-only fallback. This candidate's default text collector does not invent screenshots. A production visual collector and its actual UI/provider acceptance remain open; the offline synthetic PNG is only a byte/transport/provenance fixture.

`configureFactoryCheck(tx, task, runId, hostPolicy = defaultRunPolicy())` freezes canonical `applyApprovalMode(hostPolicy, 'read_only')`. Network allow/ask/deny and its domain list remain the host's, rather than a Factory-wide empty-list/ask override. Shared filesystem, dependency and push restrictions are unchanged. `READ_ONLY_DENIED` declares `run_project_script`, but adapters use command-specific rules and the read-only sandbox; the declaration does not prove every shell command is blocked. Real Harness frozen-command acceptance is still required. No isolation is weakened.

`test:factory-check-recovery` exercises the real registered adapter, actual SDK context and unchanged frozen grants. The migrated PG/HTTP suite now executes the actual shared request/Map/host-receipt code with a Gateway HTTP stub, not a hand-built vision assertion. Its synthetic response and PNG do not prove real model judgment. It covers replay before inference, no checked-out SQL client during inference, concurrent reservation, null/refusal/defer, malformed receipts, cancellation/access/CAS races, no programmed human fallback at zero confidence, actual image parts/digests and source/time/pixel mutation rejection. Original failure data is retained while bounded repair excerpts are redacted.

Actual production credentials/budget, visual collection, controlled real vision requests and real CC/Codex isolated execution/resume remain unaccepted. The generic Coordinator's generation/planning model is separately owned; this consumer does not change its frozen selection or introduce a paid fallback. CI/default-off/tool registration does not complete Factory functional acceptance. Merge/deploy remain HOLD. No live-eval, provider write, production SQL, credential decryption or flag rollout is performed by this increment.

## Host collector injection and registered-entry offline contract

`factoryRuntimeForBot(botId, lifecycle?, configure?, validateCheck?, consumers?, recovery?)` now forwards its sixth, server-owned `FactoryCheckRecoveryDependencies` argument to `createFactoryCheckRecovery`. The first five #192/#195 arguments are unchanged; `createFactoryStore` still takes Bot identity third and lifecycle fourth. `recovery.collectImages(tx, observation)` is a local/DB reader seam, not a tool parameter or a model-origin claim. The runtime does not install a fabricated production screenshot reader. A host can bind an existing trusted collector during server composition; the ordinary registered step still uses the default runtime until that composition is supplied.

The migrated suite additionally executes the actual registered tool, durable recovery step, runtime constructor, real store/events and shared `invokeDecision` request/receipt code in one chain. Only the database connector/actor guard, unrelated side-effect callbacks, host collector and Gateway HTTP response are fixture boundaries; there is no step, store or decision implementation replacement. The runtime wrapper binds the actual constructor to the synthetic collector through its real sixth argument. Text observations require no image. A synthetic-image observation submits image parts and binds the resulting real host receipt; required missing images produce pending with zero HTTP calls. Completed replay does not infer again. A revoked native scope rejects before runtime/model resolution. Existing original core tests still cover ownership, cancellation, candidate, session, evidence and pixel races.

The test uses the existing module-mocking runner flag and retains the local PG database and synthetic records. It does not enable native Coordinator, live-eval, real provider traffic, production SQL, flags or deployment. Real collector installation, model-account/budget scope and actual Factory UI/Harness acceptance remain open. #331's shared files and routing ownership are unchanged.

## Historical resource preservation hold (2026-10-28 21:48)

The latest user instruction requires retaining running resources and audit logs, stopping automatic deletion/cleanup, and reviewing setup/teardown before any related rerun. The Factory daemon fixture no longer stops retained daemons or deletes fixture directories in `afterEach`, including when `FACTORY_EVIDENCE_OUT` is absent. The owned reader/consumer DB suites retain their schema/database; releasing clients is not resource deletion. This does not establish that the runner/host itself retains resources.

Related existing shared CI paths still include destructive bootstrap/schema cleanup, routing-test deletion, account session/file cleanup, other daemon helpers, Docker `--rm`/forced removal and hosted service teardown. Those shared owners require coordinated fixes. A currently running job uses an immutable older checkout; changing this source cannot retroactively change that job. Do not cancel/kill a job to trigger cleanup, push a replacement that automatically cancels it, rerun these suites, or treat historical green results as resource-retention acceptance. No deletion, rebuild or restoration of existing resources is performed by this patch. The retention change is source-only and has not been runtime-tested under this hold.


## Historical static entry block before the later authorization

All three resource-owning Factory fixture modules now fail immediately at module entry, before their Pool/schema/database/HTTP/Daemon setup. This is an unconditional source guard, with no environment-variable bypass and no skipped-as-passed path. Original test assertions remain below it. The fixtures are blocked/unrun; no test, build or provider request was used to validate this patch.

Removing only `afterEach` stop/rm was insufficient: normal daemon run completion still reaches `discardIfEmpty`, heartbeat reaches prune/sweep, signal/startup-error/lock-loss/drain paths reach stop, and stop can close/remove sockets, reset sandbox and remove PID/lock files. Broker startup also removes a pre-existing socket, and outbox delivery can remove journal/ack files. Read-only candidate policy controls execution/publish behavior, not fixture lifecycle retention. A non-deleting broker suspension and daemon/runner integration must be supplied by the existing owner before these entries can be reconsidered. No shared broker production code or existing resource is modified by this source patch.


## Current hosted-CI authorization scope (2026-10-28 22:53–22:59)

The later explicit user authorization covers existing CI reading Staging secrets and cleanup of this run's newly created hosted temporary test resources. Secret values must not be exposed to models, logs or third parties. It does not authorize production migrations, deletion of existing business data, preserved local resources or protected audit logs, new credentials/accounts or persistent access. Historical cleanup observations above are not retroactively converted into retention acceptance.

The temporary unconditional fixture holds are removed. The two DB suites retain their original strict Actions/loopback-target checks and every test assertion. The daemon process fixture is restricted to the existing hosted CI environment before setup; it stops only the daemon instances it constructs, revoking their authority, and retains fixture directories/evidence. It does not call cleanupTempDirs or target the pre-existing preserved local PG service. Hosted job resource recycling is covered only for that job's new temporary resources. No operator is asked for another general engineering approval.

Actual provider/Harness/UI acceptance still needs the correct existing account, permission and exact runtime, and specific denials are not bypassed. Tests must actually execute; a fail-fast, skip, mock transport or green historical run does not establish full Factory functional acceptance.
