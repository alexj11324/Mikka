# Issue #1372: local read cache and incremental reads

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

The next Docker continuation was rejected by automatic approval review before modified-code acceptance ran; no post-change Docker result is claimed. The repository's existing GitHub CI remains the final source/database gate.

Production acceptance is pending. Record the exact submitted commit, matching CI jobs, production deployment/build ID, authorized read-only test identity allocation, page/trace measurement windows and the four required surfaces (Bot chat, task board, task detail and Settings). Populate actual measurements only from those runs. Production acceptance and issue closure are not established by this draft.
