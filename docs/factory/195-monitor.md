# Factory monitor consumer (#195)

Initially branched from PR #197 `605bf086d4371e19f2df2e2857a487f1decd649d`, then merged the explicitly coordinated unified #191/#192 baseline `4cd3a1b5fa05773094722bab7774e15a8d49d018` (`codex/factory-unified-192-191-20261025`) without conflicts or force push. Shared runtime/contract code is unchanged; the inherited baseline also adjusts performance-test request accounting. Its CI must be reported separately, never assumed green.
Read the full [issue](https://github.com/alexj11324/Mikka/issues/195) (zero comments at implementation), `AGENTS.md`, `192-contract-v1.md` and `contract.ts`. Neither the checkout nor the frozen tree contains `.agents/skills`. No state contract, other consumer validators, review/approval implementation, dispatch, frontend, Linear worker or wake implementation is changed.

## Integration

`server.ts` installs only `monitorGate` through `createFactoryStore(pool, authorize, gates)`. Existing Coordinator prompt preparation calls `factoryMonitor.reconcile(userId)` after run reconciliation. It consumes durable `run_finished` records for the current bound monitor attempt. No timer, scheduler, subscription, public pass endpoint or model tool is added. Pending records survive process restarts; #176 still supplies reliable wakes. #193/#194 must install their independent validators on the integration candidate before actual progression can reach monitor.

`consume(userId, {binding, sourceEventId})` checks current issue access, owner, cancellation/revocation, full candidate/attempt/revision fence, actual completed run/session and persisted source event. It derives workspace identity from the existing issue/team link in the existing workspace database. Legacy workspace issues without that link use their persisted Linear team mapping; an unknown workspace is isolated by issue ID instead of being merged into the personal-owner partition. Actual personal issues partition by owner. No caller-supplied owner/workspace is accepted. Fingerprints hash repository, environment, component (candidate scope), check and normalized failure output inside the owner/workspace partition. Raw output is never copied into observations, comments or Coordinator notices. Original logs stay in existing access-controlled run reports. Candidate environments and run/session identifiers already belong to the shared contract; callers must continue supplying non-secret identifiers.

The application-pool transaction records observations, incident occurrence count, shared Factory `apply`, original-issue evidence comment, existing document-trigger outbox and safe Coordinator notice together. The original issue is retained; a second local backlog item is never silently created. Distinct failures have separate incident fingerprints. Identical event replay increments delivery count without duplicating the observation, issue comment, occurrence or notice. A check-level advisory lock serializes competing tasks; original issue access is rechecked when reusing an incident. The same raw event cannot be rebound to another task. Monitor notices use existing `run_blocked`/`run_report` kinds and are never reconsumed as monitor input, including after Linear echoes.

Evidence comments use the existing Yjs issue document and comment sync path. They include exact SHA/environment, task/candidate, source event, run/session, artifact and fingerprint. The existing Linear link remains the mapping source; this consumer neither copies/replaces that link nor makes GitHub/Linear API calls. No external issue was created or modified for acceptance. The current repository has no durable GitHub-issue-to-Mikka mapping equivalent to `linear_issue_links`; actual GitHub/Linear mapping readback and explicitly authorized new external-gap issue creation require coordinated acceptance scope. Never infer a GitHub issue mapping from a PR URL or notification suggestion.

## Recovery and contract boundary

Failures remain visible in the original issue. Existing authenticated `repair` creates a fresh execute attempt and clears candidate eligibility; this module never dispatches a repair. A recovery pass needs an existing completed, unchanged-worktree monitor run with exact SHA and real check command, after passed review, independent verify, human approval and publish attempts for that exact candidate. Run/session identities must be independent; evidence and source records must still exist. A successful daemon report alone is insufficient. Incomplete verification/publication records produce blocked, never recovered. A pass marks incident records recovered and retains issue visibility; it does not close the issue or release anything.

Frozen v1 explicitly disallows `finish` from a passed/failed/blocked task and `repair` from passed. Therefore a later event on a terminal monitor attempt is recorded with `transitionBlocked=true`, and an attention notice reports `factoryMonitorTransitionBlocked`. It never overwrites the shared stage. Coordinated contract work is needed to represent renewed monitoring after an already-passed monitor (or an explicit new routed task). This candidate intentionally does not alter `contract.ts`/`store.ts` to resolve it. Also, the current reconciliation creates candidate environments of the form `device:<id>`; #194 and #181 must agree how the exact actual deployment environment is represented before claiming Preview recovery. A read-only Harness report may have `publish.commit=null` (`no_changes`); that cannot establish exact deployed SHA for this gate. A trusted deployed-check producer with actual exact-SHA provenance is still required before real recovery can pass; a model-supplied claim must never fill that gap.

## Reproducible layer validation

In this isolated Linux execution environment (not the developer's Mac):

```sh
docker run --name mikka-monitor-195-pg --rm -d \
  -e POSTGRES_USER=monitor -e POSTGRES_PASSWORD=disposable-local-only \
  -e POSTGRES_DB=mikka_monitor_195 -p 127.0.0.1:55495:5432 postgres:17
FACTORY_MONITOR_TEST_URL=postgresql://monitor:disposable-local-only@127.0.0.1:55495/mikka_monitor_195 \
  node --import tsx --test lib/factory/monitor.test.ts
node --import tsx --test lib/factory/contract.test.ts lib/coordinator-events.test.ts
node_modules/.bin/oxlint lib/factory/monitor*.ts lib/factory/server.ts workflows/coordinator/steps.ts --deny-warnings
node scripts/check-migrations.mjs
docker stop mikka-monitor-195-pg
```

The loopback database opt-in never reads app/production environment URLs or CLI credentials. Tests bootstrap all tracked SQL in a fresh schema, reapply this migration, and exercise real PG17 transactions/concurrency, rollback before commit, pool replacement after commit, replay, authorization, owner/workspace/candidate isolation, echo rejection, original-issue association, repair, failed recovery and same-candidate recovery. The #193/#194 gates and Harness run records in this layer are explicitly fixtures. They are **not** proof of human approval, real Harness execution, deployed runtime recovery or final acceptance. CI also runs these tests on its temporary PG17 service; type checks/builds remain in remote CI.

Migration: `20261025014500_factory_195_monitor.sql`. #192 remains `20261025010001_factory_192_stages.sql`; unified #191 uses only `20261025011347_run_dispatch_keys.sql`, with neither old `20261025004500` nor candidate-only `20261025011101` file present.

## Remaining real acceptance

Preview deployment for this batch was denied by automatic approval review in the parent thread; user authorization is pending. Do not retry deployment or use another path. No deployed acceptance URL exists for this candidate. Continue isolated local checks only until that restriction changes.

After authorized fixed Preview plus #193/#194 integration: run actual chat/Harness on exact candidate/environment, inject and recover a real deployed fault, send ten concurrent/replayed actual events, verify existing GitHub/Linear mapping and echo behavior, test cancellation/revocation, independent verification and publication approval, restart/compensation, then retain sanitized actual run/request/event/session logs and relevant real UI captures for private Pages/#181. External issue writes must be explicitly within #195's authorized acceptance scope. No third-party messages, new paid resources, IAM grants, persistent access or secret transport are authorized here. This issue remains incomplete until those gates and independent review pass.
