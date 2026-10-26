# Legacy generation retirement and read compatibility

Base main: 470c5cd4873634ff2b992598349ab52cffe1ee62. Inputs: #293 78e079a9dc9cac037df7a9f869486284569e4c94 and #303 6937c0a7e918b5354bdcd55192d0c988c758727d. Both source histories are preserved with normal merges.

The old POST generation entry remains absent (405). Canonical image GET, legacy GET alias, saved history GET, request logging, current active execution reporting and Bot's 120-round policy remain. Current main SSR/unread behavior and layout are unchanged. Only the previously reviewed retirement archive replaces the retired generation surface. No Coordinator hotfiles, SQL, provider credentials or deployment configuration are changed.

Conflicts: retire main's old POST and its unused web-tool implementation; combine main Unread and retirement LegacyChat translations; keep current package scripts and rounds tests; keep retirement browser cases instead of resurrecting #303's older generation mocks. The retained image test uses the canonical images path. The combined cloud workflow builds once and runs retirement/history/performance/progressive-loading/history-observer plus current Bot image tests, using only synthetic fixtures and controlled image transports.

## R0 integration boundary

Current main has the PR171 required DB inventory, not R0 recipes. Its inventory 6/6 passes unchanged. Read-only inspection of auth #291 bc7c98918c9592df2c115b1e447aafcebaa41070 found scripts/db-test-recipes.json and db-test-plan.mjs; this candidate does not overwrite those owner's pending files or import their mixed runtime stack.

`test:legacy-reads` has 9 source/handler tests with auth, image transport and history reader stubs; it performs no PG operations. The current-Bot image and archive acceptance tests are post-build Playwright tests using the workflow's isolated mikka_e2e database, not pre-build DB recipes. When composing R0, retain this dedicated post-build workflow/profile and register its coverage with that owner if the final recipe inventory includes browser profiles. Do not label stubbed handlers real PG tests or exclude actual required DB suites to pass the gate. No R0 registration has been applied to #291 by this candidate.

No live model, provider, production, migration or authentication acceptance is claimed. Search/scrape durable registration remains S's separate current Bot integration; exporting a tool module here is not proof it is registered in the runtime.
