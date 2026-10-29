# Public PR consolidation — 2026-10-29

Base: `142e1304f5d647264ffa62fdce37b1fab2222003`. Snapshot: 36 open PRs.

## Scope

This integration collects public changes into one tree on current main. The final aggregate commit is parented to current main, so excluded enterprise branch ancestry is not imported. #265 is excluded. #287 and #313 contain mixed enterprise ancestry; their public behavior is retained from current implementations and their enterprise residue remains outside this PR.

An older PR marked covered is superseded by current main or a named successor. It does not mean every obsolete file or interface was reintroduced.

| PR | Frozen head | Disposition | Reason |
| --- | --- | --- | --- |
| #13 | `2d8777b17256` | covered-by-current-or-successor | Current main intentionally removes standalone Agent management. Trusted harness/permission execution is covered by #398 and automatic device execution by #359/#362; do not restore the obsolete HeroUI role/model-picker UI or blanket bypass defaults. |
| #54 | `407ddbcde133` | integrated | Local/cloud acceptance documentation. |
| #157 | `5d8a3d1c167e` | covered-by-current-or-successor | Current main cloud-computer runtime and #346 supersede the old standalone remote transport. Preserve dedicated device/workspace bindings and existing policy, without reviving the retired ask-everything transport. |
| #166 | `1d84f4cf47ef` | integrated | Serialized group routing and durable correction state. |
| #206 | `9e610781af27` | covered-by-current-or-successor | Current main BYOS custody/email recovery and the #345/#377 account architecture supersede this earlier draft. Keep current owned bindings and cleanup paths. |
| #240 | `39147229fb34` | integrated | Idempotent Coordinator message submission. |
| #265 | `50598846e592` | excluded-enterprise | Tenant budget/quota enforcement (#215), explicitly excluded by the request. |
| #287 | `fe0c9152baf5` | public-covered-enterprise-excluded | Public mailbox/scoped exchange behavior already exists in current main. Do not import inherited enterprise audit/export stack or the retired group executor. Keep this mixed PR open for its excluded enterprise residue. |
| #300 | `e4e901466805` | public-delta-integrated | Port durable Telegram reply receipts and recovery. Retain current 120-round behavior; exclude inherited organization policy, tenant quotas and audit stack. |
| #301 | `1682ed092e14` | covered-by-current-or-successor | Included through successor #365 (ancestor relationship verified). |
| #304 | `1001971b44d4` | covered-by-current-or-successor | Safe diagnostics are byte-identical to the current main classifier; the earlier credential broker is superseded by #345. |
| #308 | `42f0d5c4ccba` | covered-by-current-or-successor | Current main approved writes, cancellation/replay protections, and #392 preserve and extend the public behavior. |
| #313 | `77c9984a55af` | public-covered-enterprise-excluded | Preserve current owner-only threads, automatic test accounts and mandatory DB inventory. Do not import inherited enterprise audit/export/disposal or obsolete R0 runner composition. Keep this mixed PR open for its excluded enterprise residue. |
| #316 | `4c1255dbbb81` | covered-by-current-or-successor | Included through successor #395 (ancestor relationship verified). |
| #318 | `ae2cc7531b70` | integrated | Site search, read-only group history, and explicit personal scope. |
| #338 | `ba0d6ca05ff6` | integrated | Server-backed issue relation lookup. |
| #345 | `eedc0f0b8846` | integrated | Personal account credential vault with isolated KMS broker. |
| #346 | `a18dfd27dbb3` | integrated | Owner-scoped browser subagents and separate Thread machines. |
| #359 | `bdecd4e905f6` | integrated | Local execution discovery and canonical repository cache. |
| #360 | `7ecd963472ac` | integrated | JavaScript daemon package and browser device authorization. |
| #361 | `335298164132` | integrated | Approved repository publication and durable GitHub PR results. |
| #362 | `61d231717826` | integrated | Automatic test-account MVP acceptance on the current local runtime. |
| #363 | `661adbc8acc0` | integrated | Screenshots and recordings as owner-scoped run evidence. |
| #365 | `c7e90be1cb67` | integrated | Explicit team choice, personal scope retirement and generation fences. |
| #375 | `172ea15341cd` | integrated | Secondary button styling. |
| #377 | `564687642461` | integrated | Connected app icons, controls and account reconnect/disconnect. |
| #378 | `00cd1f716ce8` | integrated | Remaining connected-subscription quota display; personal account UI, not tenant budget enforcement. |
| #385 | `283a64232fe4` | covered-by-current-or-successor | Included through successor #386 (ancestor relationship verified). |
| #386 | `b92633177829` | integrated | Scoped Factory lifecycle, independent checks and model recovery. |
| #388 | `0aceacba24fd` | integrated | Candidate-bound approval, policy authority and publication consumers. |
| #389 | `8561dfd4683d` | integrated | Scoped monitor observations and incident/issue proposals. |
| #392 | `ba8177e1acba` | integrated | Personal write policy and real-image model execution. |
| #394 | `9e052675f922` | integrated | Image-bound Decisions judgments and durable triage retries. |
| #395 | `fef4ef272e45` | integrated | Controlled Skill comparison and trusted execution evidence. |
| #398 | `bfe9875777fa` | integrated | Trusted CLI policy, tool approvals and durable network decisions. |
| #400 | `0001db1baa01` | integrated | Automatic leased accounts for ordinary local/cloud acceptance. |

Full source SHAs and branch names are recorded in `public-pr-manifest-20261029.json`.

## Composition decisions

- Local tasks keep canonical repository URLs, automatic execution-tool discovery, persisted repository admission, current CLI policy and owner/device checks. Factory and Skill dispatch join the same admission transaction; old direct inserts and manual checkout allow-lists are not restored.
- Completion preserves immutable first results and scope generations. GitHub publication pins the original task title and generation and rechecks authority at the external mutation boundary. Late results cannot attach to a new generation.
- Factory/Skill evidence, independent review, candidate-bound publication and monitor ledgers are retained. Frozen policies cannot broaden current CLI denials or restore revoked network destinations. Feature rollout flags remain at their existing defaults.
- Historical SQL bytes remain unchanged. New PR migrations run after the frozen main baseline, with checksummed aliases for identical earlier names. Ambiguous historical filenames fail before DDL and require an explicit verified repair.
- Existing required CI checks remain required. This integration branch additionally selects the complete browser and performance gate before merge.

## Verification record

Local source checks are preparatory evidence. Real PostgreSQL concurrency/migration tests, production build, full Playwright functionality/performance, and CI sandbox/official-CLI diagnostics must pass on the aggregate head before merge. Deterministic local provider fixtures are not live third-party acceptance.

The final PR and CI run links record the exact tested aggregate head. No production credentials, external messages or SQL changes are performed by local test fixtures.
