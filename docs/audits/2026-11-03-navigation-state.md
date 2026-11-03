# Navigation state audit

Report: entering a resolved thread and returning moves the list to its top.
Occurrence **10/10**, impact **4/10**, product **40**: the list is conditionally
unmounted for every thread opened over it; a reader browsing older resolved
work repeatedly loses their place. The screenshots show this exact path.

React discards component state on unmount. The previous implementation kept
search, expanded groups and selected tabs inside those components; the DOM
held scroll positions. Navigation also explicitly cleared task filters when
changing sections. Data caches do not preserve any of those values.

References: React's [preserving and resetting state](https://react.dev/learn/preserving-and-resetting-state)
and [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore).
The implementation keeps the existing conditional mounts, storing browsing
state outside the remounted components. It does not keep hidden computers,
streams or other background views mounted.

| Surface / user task | Before | After |
| --- | --- | --- |
| Open a resolved thread and return to All threads | Search disappears; resolved group collapses; scroll resets | Search, resolved expansion and scroll restored per sender filter |
| Open a thread from Bot overview, switch Bots, or reopen the panel | Tab/search/expansion reset or follow the previous Bot | Each Bot keeps its tab, search, group expansion and tab scroll |
| Return to a thread being read or composed | Draft, quote, selected tab, expanded steps and diff folds disappear | State retained per thread; successful send clears only that thread's submitted draft |
| Return to Bot chat | Always opens at the end; quote disappears | Historical reading position and quote retained; chat at the end continues following output |
| Switch group chats | Draft and reading position disappear; new output forces the end | Draft and reading position retained per group; output follows only at the end |
| Return to task/project lists | Section navigation clears filters; project sort and search reset | Task filters are kept per section/team; project search/status/order retained |
| Return to project/task detail | Project tab/details and task document-tools reset | Choices retained per object; page scroll restored |
| Return to board/list | Board display preferences survive; horizontal/column/list scroll does not | Existing preferences plus horizontal, column and list scroll retained |
| Return to Artifact/plugin/suggestion pages | Category, store tab/search or scroll resets | Category, tab/search and each view's scroll retained |
| Open Settings then return / reopen mobile sidebar or group details | Unmounted list/panel scroll resets | Sidebar and group member-list positions restored |
| Change account/workspace | Component lifetimes decide which values survive | Session state explicitly scoped by account and workspace |

Shared hook checks cover remounts, refresh through a new provider, object and
tenant switching, stale asynchronous setters, cleared drafts, unavailable
storage, malformed JSON, delayed content, loading placeholders, Strict Mode
and cancellation of scroll restoration by user interaction. The actual All
threads component has a regression test for search + expanded resolved group
and scroll after opening and returning. `pnpm test:view-state` runs these checks
and is included in `pnpm check`.

Review: no layout, text, color, component-library or navigation-address changes.
First-visit defaults and existing saved board/width preferences remain in
their existing stores. Runtime verification is recorded below.


## Initial verification

- Checkout: branch `work`, base `c23ff74f921b7951c5d7016c0e0967e3ce6e3e1f`;
  changes remain in the working tree. Executable-change SHA-256:
  `044ea795c9d641649d4c1d81c110c695f7c8ad55c771102454a2e24608080577` (changed tracked sources, package.json and the three new state files).
- Full `pnpm check` passed. Source checks run without the temporary local-server
  origin variables; those variables otherwise interfere with auth-config unit
  fixtures. No application auth policy was changed.
- Final `typecheck`, `oxlint --deny-warnings`, UI/interaction policy checks and
  `git diff --check` passed. The related component suite passed 78 tests; final
  state/chat checks passed 29 after adding draft migration and hydration handling.
  New regressions comprise 10 shared state tests, the All threads return test
  and the existing-draft migration test.
- Final production build passed with Next.js 16.4.1 on cloud Linux.
- Local API/CLI acceptance passed item 4 (real Bot-to-Bot group communication,
  real DeepSeek model, authenticated message reads, peer isolation), at
  `http://localhost:3110`, with PostgreSQL 17 in a disposable loopback
  `mikka_loop_*_e2e` database. No daemon was required for this item.
  Run `ce46aa30-9a04-4a0c-bc3f-82f8a26065df` finished
  `2026-11-03 12:34:54 UTC`; its unchanged source fingerprint is
  `1734575f19198ff44d81005e8e3c24c918652034a2adccb017e5715fd60cef65`.
  The subsequent frontend-only draft-migration/hydration additions were checked
  by the final 29-test run, type/lint checks and production build.
- Production screenshot capture was attempted with the normal test-account
  allocator against the separate local production server at
  `http://localhost:3000`. Auth and workspace reads succeeded, but `/mikka`
  returned HTTP 307 with `Location: /mikka`; the allocator stopped at
  `ACCOUNT_INITIALIZATION_FAILED`. No screenshots or browser acceptance are
  claimed. The allocator's ownership, session and environment checks remain
  intact. The development API/CLI run above completed through the normal allocator.
- No production write, merge, push or deployment was performed during the
  initial verification. The screenshot blocker was resolved during release
  verification below.


## Release verification

The user explicitly requested continuing through merge, deployment and monitoring.
The repository's [fix release rule](../design/decisions/2026-11-03-0310-fixes-push-to-main.md)
uses a non-forced push to main after local verification, without a pull request.

The code was rebased onto main, retaining the newer backend changes and all
new test commands. Production build and screenshot capture ran at
`a36c8e62` (parent `56c5e095`); the later rebase adds only upstream documentation
and diagnostic checklists. Application source is identical across that rebase.

The screenshot failure was a local launch configuration mismatch: binding
`next start` to `127.0.0.1` while requesting the `localhost` origin caused an
absolute middleware rewrite and the self-redirect. Launching it with
`--hostname localhost` preserves the exact test-account origin, produces an
internal `/mikka/zh-CN` rewrite and HTTP 200, and the normal allocator completes.
No application navigation, authentication or test-account guards were changed.

The normal allocator authenticated owner and peer through Better Auth against
PostgreSQL 17 on the disposable loopback `mikka_e2e` database. All fixture IDs
were reserved before creation, then cleaned before the lease was released.
No external message or model call was needed for these screenshots.

[Production screenshot evidence](../acceptance/evidence/navigation-state/README.md)
was captured on 2026-11-03 at approximately 12:49 UTC and visually reviewed:
expanded resolved list at its saved position, open thread, returned list at
the same position with the group still expanded. Layout, row labels and default
first-visit grouping match the existing UI. These are screenshot captures, not
browser acceptance tests; the return behavior is asserted in the DOM regression.

Deployment and CI status will be reported with their immutable commit links.
