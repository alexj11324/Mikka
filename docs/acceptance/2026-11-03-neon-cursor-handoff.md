# Neon egress and best-practice handoff to Cursor

Status: work stopped at the user's explicit request on 2026-11-03, around 12:04 America/New_York (17:04 UTC). This is a handoff, not a claim that total production egress is explained or fixed. Do not auto-merge this draft or resume the previous goal automatically.

## Stop state

- All six subagents were interrupted and instructed not to resume implementation, tests, merges, deployment changes, or monitoring.
- Scheduled task `6ae9ce741fe88191bb562f6793108319` is disabled. The active Codex goal was stopped as blocked for handoff.
- Our local minute SQL/request observers (PIDs 66017 and 66846) received SIGTERM. Existing production application monitoring remains enabled; its ordinary Cloudflare/GitHub jobs were not disabled.
- No rollback, historical deployment deletion, production lock release, credential rotation, or extra paid upgrade was performed for handoff. Existing CI and automatic deployment candidates may finish normally.

## Resources

Repository: `alexj11324/Mikka`; official application: https://app.aspectlylabs.com/mikka.
Vercel team `team_C7lwxVVvnUicFli6112mvxpv`, project `prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`.
Neon project `autumn-fire-21908520`, organization `org-sweet-lab-80289846`, production branch `br-autumn-rain-b5leflom`, application database **orvilo_mvp**, not default neondb. PostHog project 670821.

Use the existing Infisical identities and configuration; do not create identities. Existing working paths are prod:/platform (`NEON_API_KEY`, `VERCEL_TEAM_TOKEN`) and prod:/vercel application configuration. Keep credentials in memory and never print connection strings, tokens, cookies, SQL parameters, or user records. The Vercel connector previously returned403/404 for some writes; existing platform-token API access worked. A failed connector call alone is not proof of missing access.

## Latest read-only release check

At **17:05:18.643Z**, the actual official-domain alias resolved to deployment `dpl_9k1G7ezZuDVX6FLNp1bULQepcm1U`, READY, source `f3ec6c0172a30419704eb8f5966ca7b5db7bcc16`, ready timestamp1793725424418. Read the live alias again and verify commit ancestry: deployment IDs change, and historical deployment `alias` arrays do not prove current routing. The later #1147 merge still needs actual inclusion/release verification.

Unified production smoke: https://github.com/alexj11324/Mikka/actions/runs/41679589952 (head2023d3c8), both jobs success. Functional smoke and request outcomes passed; **deployment-comparison's internal report was insufficient / deployment_boundary_invalid**. Green jobs are not proof that the traffic comparison passed.

## Already merged work

| PR | Merge SHA | Result / remaining verification |
|---|---|---|
| #1119 | See PR | Database egress monitoring, separate from optimization. |
| #1123 | 00915b297f58311328be7a7049befff6092a0e8d | Task-list version checks, bounded chat/delta/history/resume; live13:31Z. |
| #1133 | 41f15bb58a96aa0fdf0090d8e73d5be79d47245e | Empty computer-review polling stops; npm0.0.375 published. |
| #1135 | 7ded3871219a5dc6c9c765416e10cc8a866d462a | Required-refresh dialog, new fetch/SWR pause. |
| #1137 | 330fe154f62146ab232c200bb12ebd26440d0a6e | Minimum daemon375; revoked credential remains401 and obsolete re-registration426. Original-token/live-run cleanup exceptions are narrowly scoped. |
| #1138 | 8ab87c31f6a89866bfc2def7e8c28b90ba15778b | >=64KiB result metadata census plus ordinary1% row-JSON sampling. |
| #1139 | f7266bc7fd32eb6514319ac998aec68ca8ad2d19 | Remove unused nineteen-column credential lookup on each stream check, retain all live authorization. Production Go rebuild was verified. |
| #1140 | 73a3981ff69d3fe661742714fcbfa505b1af8847 | Required update aborts existing fetch/SSE/EventSource/XHR/R2 uploads/NoVNC and suppresses beacons; keeps drafts/version probe. |
| #1141 | 98e3b78fc60e06b8881f7d1d2d45dcac1068e0c7 | Dedicated direct account-deletion session lock, nonblocking busy, lost-session protection.32 real-PG cases passed. Natural cron200 observed without manual deletion calls or production unlocks. |
| #1142 | 655b1f38b3c55ea19b97227d640d91eec5918d11 | Node connection PG plaintext-byte counters, including workspace pool; deployed and actual logs observed. |
| #1143 | dfb85ebeb973ccc056c43627a186e755c18b581c | Durable provider-only fallback from existing minute Cloudflare tick,15-minute successful cadence. Two natural PostHog/DB successes16:23:23 and16:39:21Z. |
| #1144 | 0ee9af394f490e20c7b66f1e3c309bc172890850 | Permission checks project complete task attrs instead of body. All double reads/locks/membership checks/frequency preserved;27 real-PG/HTTP checks. |
| #1145 | 2023d3c882bb8cad40876de4ff225732afd9798c | Thread-list version probe, user-scoped SWR, heartbeat-stable waiting state. Live16:57:01.627Z. Real119-row fixture94,444→106 PG bytes; HTTP88,416→125 bytes, not billing percentages. |
| #1147 | d07e4897d9578f33a7828d6fc0fda16373380a67 | Remove unused quota field for active/native_active; model/native quota checks stay. CI green and merged; latest production inclusion still needs verification. Actual quota mean277B/max382B, not the139KiB synthetic test size. |

## Uncommitted source preserved by this draft

Only the connection/lifecycle worktree had unfinished source changes at stop:
`/workspace/mikka-neon-connections`, branch `codex/neon-connections`, base2023d3c8.
This draft saves the code **as it stood**. It is incomplete and has not completed the required test/build/acceptance cycle. No claim of readiness or runtime acceptance is made.

- New `lib/db/pool-lifecycle.ts`: `attachDatabasePool`, idle-error handling, one-time registration; wired into default/request/workspace/fence pools.
- Add direct dependency `@vercel/functions`3.10.2 with lockfile entry.
- New `scripts/postgres-connection.mjs` plus declaration/test: direct Neon URL derivation and routing-override refusal.
- Migration/apply-sql scripts and account-deletion lock use the helper; migration tests were edited.
- Resume review for lifecycle behavior outside Vercel, checked-out transaction safety, host/query routing overrides, TLS preservation, migration target attestation, actual test-script registration, full lint/typecheck, real isolated-PG migration/concurrency/error cases, and production build.

Other newly created audit worktrees were still clean (no hidden source patch):
`/workspace/mikka-neon-schema-invariants` and `/workspace/mikka-query-sync-egress`.
Do not commit untracked node_modules symlinks or alter the original dirty `/workspace/Mikka` worktree.

## Remaining best-practice backlog, with evidence

1. **Schema/constraints:** read-only catalog showed226 tables/504 indexes/zero invalid indexes. Two historical NOT VALID constraints, `agent_runs_bot_fk` and `execution_rules_explicit`, had zero aggregate violations. No validation migration was written before stop. Recheck and validate with a real isolated-DB migration test.
2. **Primary-key judgment:** coordinator_sessions has `UNIQUE NULLS NOT DISTINCT(userId,botId)` and two legitimate NULL-bot sessions. Do not mechanically add a NOT NULL composite PK or destroy these rows.
3. **Indexes:** account.userId had460 observed owner-only reads and no unconditional leading index; inspect the actual plan/table scale before adding one. Do not bulk-add FK indexes or drop unused candidates. Existing session id+userId queries already benefit from the PK.
4. **Queries:** listDevices polls every5s and overfetches devices/repos; issue members/relations paths load task bodies for permission checks where an existing without-body access helper may apply. Preserve full scope/lock/auth checks.
5. **Group chat:** active polling rereads the latest50 message bodies; cursor/version delta is not implemented. Preserve membership checks, edits/deletions, ordering, history pagination, drafts and reconnect behavior.
6. **Artifacts:** viewer polls getArtifact every15s; lib/artifacts/store.ts detail/readArtifact fetches all version metadata for the version menu. Conditional metadata reads are not implemented. The signature must include title/share/bot/agent names and images, not latestVersion alone. getArtifactText is a separate on-demand content/auth path. Do not truncate the menu or weaken authorization.
7. **Observation:** Node protocol counters omit Go workers, startup/pre-gate bytes and unreported/frozen runtimes. Durable minute SQL snapshots and Go protocol measurement were only proposed, not implemented. Existing workspace-local minute processes were stopped for handoff.
8. **Comparator:** deployment-comparison repeatedly reports boundary invalid. Find the real metadata/time boundary issue; do not turn missing/incomparable data into pass.
9. **Legacy UI:** listThreads remains as a compatibility full-read action; only updated clients use known-version polling. Inspect actual adoption before declaring all clients optimized. Do not force reload in a way that loses drafts.

## Measurement facts and limits

Provider public-network UTC hours:11–12=62,894,267B;12–13=89,687,082B;13–14=125,739,216B;14–15=105,027,042B;15–16=119,224,160B.13–14 mixed releases;14–15 still had old routing until14:44.The last saved provider read at17:03:55.225Z reported53,745,298B for16–17. That hour had ended by the clock, but provider backfill/finality and comparable workload were not established; no verified same-load post-fix billing result has been established.

Neon API supports hourly/daily/monthly consumption, approximately15-minute reporting. Unchanged buckets are not zero-minute traffic. SQL calls/rows were sampled as cumulative differences every60s without reset; rows include affected rows. Upgrade10:56:54Z/statistics start10:57:56Z prevents exact reconstruction of the preceding1GB.

Actual activity peaked around16:27–30 at7,282/9,796/8,224/7,962 SQL calls/minute. Real tool/model/front-end activity accompanied it; not all those queries are waste. HTTP counts do not include each SQL inside a long-lived request. Permission-chain task-body overfetch was independently confirmed.

Node protocol examples:16:49:13–50:13 one runtime/seven connections93,873B;16:52:49–53:49 another runtime/eight connections173,003B;2023's16:58:09–59:09 one runtime/nine connections75,279B. These are **observed PG plaintext bytes**, not JSON estimates, HTTP bytes or vendor billing, and the windows/workloads differ. Do not calculate a reduction from these examples.

Random row samples use sampleRate.01; large-result census uses1. Four119-row thread responses totaled283,220 actual captured JSON bytes; do not multiply census by100. Keep supplier, protocol, sampled JSON and application HTTP measurements separate.

Official proxy source excludes TLS/header overhead from the documented measurement paths; no evidence supports attributing the unexplained bill to handshakes. A support-ready packet existed locally and was not sent. Do not assert a Neon billing defect without complete reconciliation.

## Runtime/config state to preserve or review

- Four remote update commands were actually enqueued: three daemons updated and remained online (last confirmed382); one failed Linux329 was explicitly quarantined by revoking its sole token at15:32:06.800Z. It had zero live runs/shared bindings. No uninstall, record deletion or production-data test was done. Restore business access only after update AND fresh login; do not re-enable the old credential.
- Official-domain Skew boundary was moved to1793721921392 (330 deployment creation), maxAge43200 unchanged. Legacy headers were verified routed to the newer build. No historical deployment was deleted.
- Sampling fallback `MIKKA_DB_EGRESS_SAMPLE=1` was written to existing Infisical prod:/vercel and existing sync succeeded16:27:26Z. Original state absent. Vercel sensitive env/key metadata exists, but deployment literal value was not directly readable; do not claim it was. PostHog explicit flag answers still take precedence.
- Budget insights retain last known non-NULL supplier values; independent heartbeat handles freshness. Alert IDs, thresholds and subscriptions were retained.20MB/hour and100MB/day are budgets, not Launch allowances.
- GitHub runtime collector had gaps, but real schedule run41674893990 at16:30:28Z succeeded. Cloudflare provider fallback independently completed two natural cycles. Do not state schedule never recovered, or conflate provider-only events with runtime samples.
- Latest verified daily email11:20:41 New York was511,378,062 cumulative bytes, not another511MB. Later broad Gmail search was rate-limited; no claim of an exhaustive latest inbox check.
- Another assistant session was confirmed by the user to have canceled new production deployments via API around16:38. The user was asked to stop that conflict. Keep a single release owner and verify actual aliases; do not revoke tokens or fight the other controller with blind retries.

## Acceptance and next actions for Cursor

Read AGENTS.md, the repository debugging/verification skills and the Neon guides. Preserve other worktrees and unrelated main commits. Continue the draft only after reviewing its unfinished state. Use real isolated Postgres and normal leased test accounts; no production test writes, no stats reset, no secret output. No browser tests; UI changes require reviewed local production-build screenshots. Existing user authorization allowed in-scope fixes to be merged/published after validation, but this author has now stopped and handed control to Cursor: do not auto-resume this Codex goal.

Verify the current deployment contains the intended final merge(s); obtain the actual final billing window and request mix. Do not call an idle/partial window a successful same-load optimization. Review the evidence snapshots beside this file and the linked PRs before changing schema or workload behavior.

Handoff tracking: https://github.com/alexj11324/Mikka/issues/1148. Connection patch source is preserved without additional implementation; subsequent commits only clarify documentation/evidence.
