# Issue #1372: local read cache and incremental reads

This preserves the #1372 implementation plan, measurements and handoffs for
the revisions recorded here. The current application uses the
[shared Vite/Hono/Nitro runtime](operations/web-runtime.md). Earlier Next/Flight
and account-pool descriptions remain part of that evidence. New acceptance
uses [the current acceptance rules](acceptance.md).

Status: implementation and measurement plan. Execution results, CI links and the deployed commit must be recorded below before production acceptance is claimed.

Implementation started from main `29f0d915a2ee10748aed6938a578cc6d539b90df`. This document describes the read protocol; it is not evidence that a build, test or deployment has passed.

## Incremental read design

The SWR provider remains the in-memory source used by components. Its IndexedDB backing restores bounded ordinary read models under an authenticated user/workspace/build/role namespace. Fetchers wait for hydration before choosing their existing version or cursor. An absent, unavailable or rejected disk record follows the ordinary authorized network read.

| Surface | Read entry point | Restored or changed read | Full data retained on demand |
| --- | --- | --- | --- |
| Bot chat | `syncCoordinatorChat` through `readCachedCoordinatorChat` | Existing `after`, `cursor` and prefix proof read the overlapping tail; later reads send the known message version. Cached task/artifact decorations are authorized again even when messages are unchanged. | A bad prefix or a gap beyond the existing 200-message window returns a new snapshot. Older history remains explicitly paged. |
| Task list | `syncIssueList` / `pollIssues` | A known aggregate version can return unchanged. Otherwise, an authorized ordered manifest contains per-row fingerprints, and only changed or missing rows are returned. | At most the existing 100 candidates; the list reads metadata and checklist counts, not task bodies. |
| Thread list | `syncThreadList` / `pollThreads` | The same manifest/delta protocol includes the visible device-waiting projection. Removed or expired rows leave the manifest. | The existing 200-row, 30-day window. Its existing presence fallback and age deadline are preserved. |
| Task detail | `pollIssue` | Fresh access checks and a shared task lock precede a fingerprint of the visible summary and stored body. Matching `readVersion` returns no body. | A changed or absent fingerprint returns the current complete task body. |
| Task activity | `pollIssueVersionSummaries` | The latest 50 history entries contain metadata, status, title and actor display data. Per-row proofs fetch only changed entries. | `listIssueVersions` loads complete historical bodies when the person opens description history. |

These fingerprints are read cursors, never permissions. No new database columns, polling interval, push-version counter or shared server result cache is introduced by this protocol.

### Manifest and deletion semantics

A changed list returns its complete authorized ordered `positions: [{ id, version }]` and a small `items` replacement set. The client merges replacements by ID, then selects only IDs in the new manifest, in that order. This removes deleted tasks, revoked tasks, deleted threads and rows that leave a bounded window without requiring a later row timestamp or a deletion journal.

The client only sends proofs for rows it still holds. If a restored list is partial, it omits the aggregate `known` value and sends the remaining proofs so the server can supply missing rows. If proofs are absent, malformed, duplicated or oversized, the read falls back to a full snapshot. A malformed proof cannot use a matching aggregate version to acknowledge an incomplete cache.

The aggregate fingerprint is read before the returned projection, following the existing reader's ordering. A concurrent committed change therefore invalidates the next read; the protocol does not advertise a cross-database transaction spanning workspace membership and application data.

### Identity and permission boundaries

Every server read runs its existing authentication and visibility checks. Task detail and activity return the authenticated `viewerId`; the client compares it with the viewer of the mounted workspace. Chat compares `live.ownerId` with the provider's authorized owner, or the previous in-memory snapshot's owner. Lists retain both their owner fence and, for tasks, their selected-workspace fence. A response from a different account cannot populate the prior account's provider.

Expected authorization failures cross the production Server Action boundary as error codes. `CacheReadError` retains that code and exposes 401, 403 or 404 classification to the provider. The affected UI stops using the cached result and retires its live subscription, including the disconnected fallback, until an explicit successful read restores it. Unexpected server exceptions retain their original exception path.

Chat message versions do not cover access to cited tasks or artifacts. A cursor request therefore reauthorizes those decorations separately. An unchanged transcript can return an empty metadata map, which replaces the prior map and removes revoked cards. The existing task-list and artifact pushes request this refresh; they do not create a new timer.

Tool display metadata has a separate recovery path. Disk retains only call/name/state/time, the original body continuation and a `restoreToolMetadata` hint; target, display name and error labels stay out of IndexedDB. A restored request computes its existing prefix hash and compact display metadata in one PostgreSQL statement snapshot. Only positions, ordered call identities and bounded display fields leave that statement, not prefix text, reasoning, input/output/quote previews or dispatch bodies. The client matches these fields to each proved reply, consumes the response-only overlay and clears the hint. Missing, reordered or ambiguous identities require the existing single full reset. Prefix edits/deletion and long gaps still invalidate the original proof.

The integrated shared-read path authorizes each requester before joining. Its key includes the current authorized manifest and normalized held proofs; chat also distinguishes the metadata-repair hint. Cited tasks and artifacts are reauthorized independently after the shared transcript completes, without mutating the shared object. Cross-tab adoption additionally requires the same authorized user/workspace/build/role namespace and an established live transport scope.

### Cached task documents

A recovered task can be displayed before its server read finishes, but its title, editor, metadata and mutation actions remain read-only. It does not create or seed `DocumentSync`. Navigation and close controls remain usable. Only a successful response for the expected viewer enables the normal document lifecycle.

The persistent projection must not preserve a content fingerprint after changing the content it proves. Non-chat records whose sensitive fields or unsupported attributes would be stripped are rejected as whole records, including task `readVersion` and activity/list row proofs. This prevents a redacted stored body from becoming a writable document after an unchanged response. A fresh read supplies the full authorized body instead.

Task 404 invalidation removes related detail/activity/history records and tombstones them against a pending hydration. Session and workspace failures retire the namespace. Full history documents, credentials and session state are outside the persistence allowlist.

## Focused regression coverage

The implementation adds or extends the following focused cases. Their presence is not a passing result; attach the matching CI run for the submitted commit.

| Fixture | Assertions |
| --- | --- |
| `lib/list-poll.test.ts` | Authoritative ordering, replacement, deletion, empty manifests, invalid proofs and proofs limited to rows actually held. |
| `lib/coordinator/chat-poll.test.ts` | Unchanged messages can replace task/artifact metadata with an empty authorized result. |
| `lib/coordinator/chat-read-client.test.ts` | Hydration precedes the first cursor request; first recovery rechecks metadata; newer in-memory responses win; access errors retain their classification; foreign viewer responses are refused. |
| `scripts/use-live-lists.live.test.tsx` | Real SWR/live hooks restore row proofs, recover missing rows, remove deleted rows and stop reading after access is refused. Existing idle/live scope assertions remain. |
| `scripts/task-detail-live.test.tsx` | A cached task renders read-only without exchanging a document before reauthorization; a refused or foreign-viewer read cannot seed a document; history bodies load only when opened. Existing acceptance and unsaved-draft behavior remain covered. |
| `scripts/issue-readonly-dom.test.tsx` | Invalid stored documents retain the established read-only behavior. |
| `tests/issue-list-egress.db.test.ts` | Real PostgreSQL list deltas, profile changes, cross-account proofs, task deletion and workspace revocation. Existing relation visibility and concurrent-link assertions remain. |
| `tests/thread-list-egress.db.test.ts` | Real PostgreSQL single-row changes, device waiting state, malformed proofs, foreign owners, deletion and the 30-day expiry boundary. |
| `tests/read-cache-detail-egress.db.test.ts` | Body changes without a timestamp/revision update, metadata-only activity, a 50-to-51 version window, actor profile changes, membership revocation, soft deletion, unchanged chat citation revocation and explicit auth/deleted-bot errors. |
| `lib/coordinator/chat-version.db.test.ts` | Existing prefix correctness, tool grouping, older-message edits and long gaps, plus restored cursor and deletion measurements. |

Minimal source/DOM invocation in the configured acceptance environment:

```sh
node --experimental-test-module-mocks --import ./scripts/server-test.mjs --import tsx --test lib/list-poll.test.ts lib/coordinator/chat-poll.test.ts lib/coordinator/chat-read-client.test.ts scripts/use-live-lists.live.test.tsx scripts/task-detail-live.test.tsx scripts/issue-readonly-dom.test.tsx
```

The database fixtures require the existing disposable loopback `*_e2e` target and matching database environment variables. Setup and teardown use only their isolated fixture rows:

```sh
REQUIRE_DB=1 node --test-force-exit --import tsx --import ./tests/fixtures/activity-runtime.mjs --test tests/issue-list-egress.db.test.ts tests/thread-list-egress.db.test.ts tests/read-cache-detail-egress.db.test.ts lib/coordinator/chat-version.db.test.ts
```

The repository's aggregate read-cache, activity, live-list, read-only DOM and idle-budget scripts remain the CI entry points. The idle budgets are not increased.

## Measurement definitions and expected behavior

`tests/helpers/read-metrics.ts` instruments `pg.Client.prototype.query` before application pools connect. It records only numeric aggregates for the measured read, excluding fixture setup. Each `read_cache_measurement` diagnostic contains:

| Field | Meaning |
| --- | --- |
| `databaseStatements` | Actual PostgreSQL client query calls across the application's pools. |
| `databaseJsonResultBytes` | Sum of JSON-encoded nonempty query result rows, using the same definition as `lib/db/egress-sample.ts`. |
| `databaseSocketBytes` | Bytes received over the fixture process's database sockets during the read. This includes PostgreSQL protocol overhead. |
| `actionJsonBytes` | JSON bytes of the returned action/store read value, before any HTTP/RSC framing. |

The comparison is explicitly a **data read path**, not an entire page's HTTP traffic or database-provider billing. Chat's store fixture also excludes action-level authentication queries. Production traces and page-level request counts must be recorded separately.

The fixtures compare a full reader without a saved version/proof (`legacyReload`), a cold browser snapshot, `warmKnown`, `reloadRestored`, a changed row/turn and a deletion. `legacyReload` simulates the previous reload protocol using the current fixture and full entry point; it is not a byte-for-byte execution of an earlier release commit.

Expected relationships, to be verified rather than reported as results:

- Warm and restored lists return an unchanged envelope when there are no changes. A changed list transfers a small authorized manifest plus changed rows, rather than the entire visible list.
- A restored chat replays its overlapping tail and current decorations. A prefix deletion/edit or a long gap deliberately costs a full snapshot to maintain correctness.
- A normal task-detail mount no longer transfers fifty historical documents. Its activity read contains summaries, and a warm detail read omits the unchanged current document.
- Authorization reads remain on every request. Cold fingerprint/manifest paths can execute more small statements than a full reader; the intended savings are fewer repeated requests and substantially less returned data, not an unconditional reduction in every cold-query count.
- Healthy live views introduce no idle polling. Focus/visibility throttling and terminal retry behavior are measured independently through the shared SWR policy and idle-budget fixtures.

## Executed pre-change baseline

The unmodified application at `29f0d915a2ee10748aed6938a578cc6d539b90df` was measured with instrumentation-only copies of its existing three read fixtures. Docker Cloud Sandbox Medium (4 CPU / 8 GB), Ubuntu 24.04, Node 24.22.2, pnpm 10.34.3 and isolated loopback PostgreSQL 17 were used. The run passed 5 tests with 0 failures and 0 skips in 4.65 seconds. The sandbox was stopped after this stage.

| Surface / fixture | Scenario | DB queries | DB JSON result bytes | DB socket bytes | Action/store JSON bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| Bot chat, 40 messages | Cold / reload without cursor | 4 | 62,841 | 64,429 | 64,669 |
| Bot chat, 40 messages | Warm known version | 3 | 167 | 670 | 86 |
| Task list, 30 tasks | Cold / reload | 12 | 16,491 | 19,650 | 20,848 |
| Task list, 30 tasks | Warm known version | 7 | 683 | 1,367 | 246 |
| Workspace task list, 80 tasks | Cold | 14 | 37,651 | 42,636 | 44,048 |
| Workspace task list, 80 tasks | Warm known version | 8 | 13,789 | 15,550 | 246 |
| Thread list, 119 threads | Cold | 4 | 81,462 | 83,705 | 88,536 |
| Thread list, 119 threads | Warm known version | 3 | 83 | 303 | 245 |
| Thread list, 119 threads | Reload | 4 | 81,462 | 83,269 | 88,536 |

These counts exclude fixture setup and any page-render authentication wrapper. They do not imply that an entire page reload uses this many statements. An additional authenticated cache-scope gate is measured independently in `tests/read-cache-scope.db.test.ts`.

### Production baseline trace examples

The following complete sampled traces establish real read costs before this feature. They are examples from different deployed commits and data sizes, not controlled before/after pairs. Query bytes are the existing approximate JSON-result measure, not network billing. No request body, credential, transcript or account identity is copied here.

| Read | Version | DB queries | Approximate DB JSON bytes | Trace |
| --- | --- | ---: | ---: | --- |
| Threads | `d0e064aadebf` | 5 | 166,081 | [79D73542492CF03D1A2E22552E6E4CFA](https://us.posthog.com/project/670821/tracing?trace=79D73542492CF03D1A2E22552E6E4CFA) |
| Task list, quiet warm read | `29f0d915a2ee` | 6 | 13,608 | [78EF5E7E620298A3D1758D97C591D6ED](https://us.posthog.com/project/670821/tracing?trace=78EF5E7E620298A3D1758D97C591D6ED) |
| Chat | `d76d34007ec3` | 128 | 655,974 | [51E3BF258E148A3831C457DCE1DB58BC](https://us.posthog.com/project/670821/tracing?trace=51E3BF258E148A3831C457DCE1DB58BC) |
| Settings model order | `d76d34007ec3` | 19 | 45,723 | [C890739F48E2ECF87F6BADFEE7C23BA0](https://us.posthog.com/project/670821/tracing?trace=C890739F48E2ECF87F6BADFEE7C23BA0) |

## Execution and production record

Initial source-only verification: 83 cache, real React/SWR, IndexedDB adapter, chat merge/reader, list merge, live-channel, retry and settings-read tests passed, with 0 failures and 0 skips, in 5.23 seconds. Node 24.22.1 used the repository-locked React 19.3.1, SWR 2.5.1 and pinned fake-indexeddb 6.2.4. No application, database or browser test environment was started for this source-only run. The polling and error-cause source policies also passed. These preliminary results will be replaced by commit-bound CI results.

The next Docker continuation was rejected by automatic approval review before modified-code acceptance ran; no post-change Docker result is claimed. The repository's GitHub CI remains the source/database gate.

The first draft CI run on `5eb7babda486a1c9b83b13ec73dc28cf8241b7cc` found TypeScript union inference, incomplete SWR test mocks and a source-only IndexedDB test whose filename was incorrectly classified as a PostgreSQL suite. The follow-up fixes preserve the wire protocol, complete the mocks and rename that test to `indexed-storage.test.ts`; they do not relax the database classifier or required checks. After those fixes, the focused source-only suite passed 83 tests with 0 failures and 0 skips, and the API-driver/database-runner guard suites passed 27 tests with 0 failures and 0 skips. The new commit still requires matching CI results.

### Isolated API acceptance

The `Read cache API acceptance` workflow uses a disposable loopback PostgreSQL service, the existing environment/database attestation and normal owner/peer account leases. It builds this checkout with `pnpm build:app`, then owns the compiled Node API
process through `productionApplication`. The driver uses the registered
`/api/rpc` actions and restricts business requests to five named read actions
and bounded GET paths. It exercises cold, warm, restored cursor, changed row, deletion and foreign-account cases without sending a message, dispatching a run or invoking a model. Synthetic fixture edits are restricted to registered resources in the isolated database. No browser test runner is involved.

Run against the configured, attested isolated environment with:

```sh
pnpm build:app
node scripts/acceptance/run-read-cache.mjs
```

The workflow retains only `.cache/e2e/http-acceptance-summary.json`, after the existing evidence audit. It contains scenario names, HTTP/result byte counts and generated trace IDs, not response bodies or credentials. The 6 driver source tests pass; real HTTP acceptance is pending and is not implied by those source tests. Browser persistence, hydration and focus behavior are covered separately by the real SWR/IndexedDB adapter tests and subsequent read-only production observation.

### First executed post-change database measurements

[CI run 42031092763](https://github.com/alexj11324/Mikka/actions/runs/42031092763) checked out PR merge SHA `e461b55bd5665398348c86b0371dc9c3a1cde12b`, associated with feature head `17605fae372d7429312e6a9cbfd840638e7fd256`. The following diagnostics actually ran against isolated PostgreSQL. This run was not fully green: a later detail fixture incorrectly attempted a workspace promotion without the existing authorization path, and several older mocks/type assertions needed updating. These numbers are partial measurements, not completed acceptance.

| Read / fixture | Cold DB queries / JSON bytes | Warm DB queries / JSON bytes | Restored reload DB queries / JSON bytes | Cold / warm / reload returned JSON bytes |
| --- | ---: | ---: | ---: | ---: |
| Task list, 30 tasks | 14 / 19,104 | 8 / 683 | 8 / 683 | 23,592 / 246 / 246 |
| Thread list, 119 threads | 5 / 90,499 | 3 / 83 | 3 / 83 | 99,379 / 245 / 245 |
| Bot chat store, 40 messages | 4 / 62,841 | 3 / 167 | 8 / 743 | 64,669 / 103 / 554 |
| Settings preferences and prefix | 4 / 0 | 4 / 0 | 4 / 0 | 292 / 292 / 292 |

Settings has no durable rows in this fixture, so its zero JSON-result bytes do not mean zero traffic: the corresponding PostgreSQL socket bytes were 1,204 / 599 / 599. Settings without live coverage continues to revalidate. The authenticated namespace gate separately used 1 statement, 100 result bytes and 799 socket bytes. Chat's store measurements exclude the action's session/metadata checks. The initial task-list `legacyReload` mixed in personal-workspace initialization and is excluded from the comparison; fixture setup now performs that initialization before all measured reads. Detail/activity has no final numeric diagnostic from this failed run.

One changed task returned 3,953 database JSON bytes and 3,702 action JSON bytes; one changed thread returned 9,843 and 11,866 respectively. A restored chat performs more small proof/tail queries than a full snapshot. Deleting an old chat message correctly reset the prefix and required a full response (60,418 database JSON bytes, 62,024 returned bytes); a deleted message is never retained just to preserve the savings.

### Executed metadata recovery and combined-read measurements

[CI run 42047606396](https://github.com/alexj11324/Mikka/actions/runs/42047606396) checked out merge SHA `7fe43d49a269a03b749b4906e1540423a346f461`, associated with feature head `cb849283f87db1ba0653437734f407b26ce8dff7`. Its tree `3767b0863d4e63cebf7e8fff8beae852e8b5aba0` exactly matches the published integration of main `3251144`, #1384 and this cache protocol. These are executed measurements, not a completed release: three DB shards passed; the fourth failed three shared-read fixture assertions, and Source found a generic-union narrowing error.

The new real PostgreSQL metadata fixture passed, as did all 90 tests in `test:bot-chats-db`. It uses the actual `persistentReadData → chatUpdate → mergeChat` path and validates hidden tools, repeated call IDs in separate replies, same-statement query count, append, prefix edits, deletion, cursor-ahead and long gaps.

| Tool-chat store, 40 messages | DB queries | DB JSON bytes | DB socket bytes | Returned JSON bytes |
| --- | ---: | ---: | ---: | ---: |
| Full reader / cold snapshot | 4 | 95,842 | 97,396 | 97,065 |
| Warm known version | 3 | 58 | 554 | 104 |
| Ordinary overlapping tail | 8 | 5,197 | 6,610 | 5,336 |
| Actual disk restore + tool metadata | 8 | 6,065 | 7,589 | 6,288 |
| Appended turn | 8 | 6,309 | 7,806 | 6,304 |
| Changed prefix, full reset | 5 | 92,777 | 94,578 | 93,067 |
| Deleted prefix row, full reset | 5 | 92,143 | 93,902 | 92,445 |

Restoration reduced this fixture's DB JSON by 93.67% and returned JSON by 93.52%, while using the same eight queries as the ordinary tail. These store measurements exclude action authentication and page-render reads. In the same run, task-list cold/warm/restored DB bytes were 19,107/683/683 with 14/8/8 queries; thread-list bytes were 83,811/83/83 with 5/3/3 queries. Detail plus activity used 55,548/2,377/2,377 bytes with 22/18/18 queries, compared with 1,776,084 bytes and 19 queries for the same fixture's old full-history read.

The natural simultaneous push fixture reduced five client requests to three, 71 queries to 44, and 86,932 socket bytes to 49,172. No server flight joined in that particular timing window: those reductions came from the three tabs sharing a request. The old 40% query / 50% byte thresholds therefore did not describe the integrated per-request authorization and manifest work. Two additional race fixtures timed out before reaching their query barrier because they installed a prototype interceptor after pooled clients had bound their query functions. Both defects are recorded as failed tests and require corrected, deterministic fixture execution before acceptance; none is counted as a green gate or as proof of an authorization failure.

The matching isolated HTTP run `42047606506` still failed before account allocation: anonymous landing preparation timed out at 120,004 ms. The owned direct child remained present, system RAM was 16,765,386,752 bytes, and cgroup OOM/OOM-kill counters stayed zero. A Next error marker was observed; no raw error message, account or fixture was emitted. Its cause remains under investigation, so these DB results do not establish end-to-end acceptance.

### Production measurement and final evidence

`Read cache production acceptance` runs after a successful exact-main Web deployment while this issue remains open, or by a manual main dispatch with the exact deployed SHA. Its automatic path verifies the GitHub event and the actual successful Web deploy run, checks that issue #1372 is still open, and pins the public application version before any credential is loaded. It uses the existing smoke-owner identity and shared `production-smoke-owner-acceptance` concurrency group. It does not add a production adapter to the isolated account pool or change its guards.

The production driver signs in normally, verifies the expected owner, reads an existing bot and visible task, then signs out only its own session. It creates no fixture and issues no business mutation. It measures the five named read actions and the Settings prefix GET under cold, warm, serialized-cursor reload and scoped catch-up cases, retaining only numeric aggregates and trace IDs. The report explicitly sets `browserCacheVerified: false`: an HTTP cursor replay does not prove IndexedDB, first paint or a browser focus event. Those require the separate cache tests and actual read-only page observation. Production trace sampling stays unchanged; an absent sampled trace is not a zero-query result.

Three additional `one-item-cache-miss` reads exercise the incremental repair path without changing production data. For task and thread lists, the driver discards one locally held row and its matching server-issued position. For chat, it retains the server-issued prefix and `after`, discards the overlapping tail and lowers its held cursor to that prefix boundary. No fingerprint is invented and no authorization check is bypassed. The report records the actual response mode, returned item count and bytes: a concurrent change may return more than one item or correctly reset the chat. These measurements describe a client cache miss, not an observed one-row production mutation. Actual one-row writes remain covered by the isolated database/API fixture.

### Takeover diagnosis (2026-11-05)

Run [42050787567](https://github.com/alexj11324/Mikka/actions/runs/42050787567), job `127326002561`, failed before account allocation with `owned_landing_prepare_refused`: the anonymous landing returned HTTP 500 after 109,314 ms. Its recorded import chain was `reply-activity.tsx` → `tool-detail.ts` → `context.ts` → `message-safety.ts`. The first module is a Client Component; the last imports `node:crypto`. The runtime import of quote display helpers in `tool-detail.ts` pulled server message signing into the client module graph. The observed worker was alive and its OOM counters stayed zero; the evidence does not support an OOM diagnosis.

The quote helpers now live in a pure `tool-quote.ts` module. `context.ts` retains compatible exports, while `tool-detail.ts` imports only its `ChatTool` type from context. Message signing is unchanged. A browser-platform bundle regression with tree shaking disabled covers this dependency boundary. The HTTP workflow uses a production build followed by `next start`; heap and timeout budgets are not increased. See the official [Next.js client/server boundary](https://nextjs.org/docs/app/getting-started/server-and-client-components) and [CLI build/start contract](https://nextjs.org/docs/app/api-reference/cli/next).

The earlier green check named `Production build and browser interactions` in CI run `42050787558` was a suite-summary gate, not an executed `next build`. It is not production-build evidence. The takeover changes require their own matching green CI and real HTTP run before acceptance is claimed.

The takeover merges main `a1b633178` (batch #1423) with a merge commit. It retains #1417: the sidebar and workspace header read `pollBotChatSummaries`, `bot_chat_list` invalidates only its own summary key, and an initial web chat snapshot uses `CHAT_FIRST_PAGE = 50`. It also retains #1418: the artifact window subscribes to `chatKeys.detail()` with a null fetcher and its embedded chat owns the incremental read. The cache continuation, prefix metadata recovery and #1405's bounded read projections remain in place. Both branches' database test entries and the bot-list-push regression are retained.

On merge head `406e05b2811137896ed454f94fe17801b4bf9d38`, [API run 42074001188](https://github.com/alexj11324/Mikka/actions/runs/42074001188) completed the real production build, started the server, and completed all 35 reads. It then correctly failed clean account release with `ACCOUNT_DIRTY`, after fixture cleanup succeeded. The driver's hard-coded English page changed the locale after the account baseline was sealed on the default page; `loadWorkspaceContext` can persistently rename a generated personal workspace for the new locale. Discovery and action requests now stay on the canonical default path, matching account initialization and API reads. The account fingerprint and release checks are unchanged; the next matching CI must prove clean release.

The same head's [CI run 42074001299](https://github.com/alexj11324/Mikka/actions/runs/42074001299) passed Source, Integration, Daemon and all four PostgreSQL shards. Core stopped at #1417's full-reader source guard because an old comment named the legacy reader. The comment is corrected to describe the current summary/delta ownership; the guard and its allowlist remain unchanged.

The authoritative final execution record belongs on [PR #1389](https://github.com/alexj11324/Mikka/pull/1389) and [issue #1372](https://github.com/alexj11324/Mikka/issues/1372): exact submitted commit, matching green CI, production deployment/build ID, identity allocation, UTC measurement windows and all four surfaces (Bot chat, task board, task detail and Settings). The owner records actual production observations there after deployment. This implementation document and the preliminary measurements do not themselves establish production acceptance or authorize early issue closure.

### Task-detail reopen correction before merge

Head `3d905311b5933a3e071eec6008ef2e7cfd6d493b` passed all ten Actions workflows and GitGuardian, including real production-build HTTP run [42077937313](https://github.com/alexj11324/Mikka/actions/runs/42077937313), 35 reads and clean account release. Independent review then found a task-detail lifecycle defect before batch #1433 merged; that batch was closed without merging. This is a source-confirmed failure path, not a claimed production browser reproduction.

SWR 2.5.1 can retain a completed request for its default two-second dedupe window, and retains an unfinished request until it settles. Its [mount effect and success callback](https://github.com/vercel/swr/blob/v2.5.1/src/index/use-swr.ts) do not promise a new hook instance its own `onSuccess`. A task closed and reopened under the same provider could therefore keep its cached preview indefinitely. Registering the preview's refused save as the navigation flush also prevented leaving an otherwise unedited preview. The earlier fixture set `dedupingInterval: 0` and did not preserve the provider across detail remounts, masking the completed-request path.

TaskDetail now disables the automatic mount read, waits for persistent-cache hydration, and uses its bound `mutate()` for one explicit fresh authorization read per opening. SWR's [mutation revalidation](https://github.com/vercel/swr/blob/v2.5.1/src/_internal/utils/mutate.ts) removes the old request marker before starting that read. The effect is cancelled when its instance or key retires. Only the actual request's `onSuccess`, after the existing server ACL and viewer checks, unlocks the form; a resolved mutate promise or a stored snapshot is not authorization. The preview registers a successful no-op navigation flush, while its save function and editing controls remain refused.

The component regression keeps SWRConfig mounted, uses the default dedupe interval, and covers completed and unfinished requests across close/reopen, permission refusal, a foreign viewer and delayed persistent hydration. It checks title/body read-only state, no premature DocumentSync/activity/save, and navigation from an unedited preview. These new cases require their own matching green CI; the earlier head's results are not evidence for this correction.

The correction shipped in `aad7e31e53e81ace9945e64c02e56eb7ee6cea9d`. [CI 42083378468](https://github.com/alexj11324/Mikka/actions/runs/42083378468) passed all gates; its task-detail suite executed 14 tests with 14 passes, including all five new regressions. [API 42083378472](https://github.com/alexj11324/Mikka/actions/runs/42083378472) passed the real build, 35 reads and clean release, on checkout `cd08008b8ac412a44a13b31ae048d535879dbe67` (the correction combined with main `6fb186e0`). All ten workflows and GitGuardian succeeded.

Before that corrected head could ship, main `a9646cf70968d58c066b10f843a45431b6036cd6` introduced #1435's Factory task-detail UI in the same JSX line, creating a real merge conflict. The next merge retains the complete cache preview/fresh-authorization/navigation boundary while moving FactoryAcceptance to the beginning of the authorized `afterDescription` block, adding its new `onOpenThread` prop, and adopting IssueActivityFeed's new signature. Both branches' test entries remain. This new combination requires matching CI before release; the correction's earlier successful run does not establish the combined result.
