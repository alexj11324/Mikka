# Browser CI execution budget

History. CI runs no browser tests at all since 2026-11-01
([decision](../design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md));
`browser-tests.yml` is deleted. The budgets below describe the removed CI
browser job.
See [CONTRIBUTING.md](../../CONTRIBUTING.md#how-changes-are-tested) for the gate policy.

The original full browser job has a 45-minute total budget. Its official Chromium/system
dependency installation step has a separate 15-minute limit. This reserves time
for the build and complete regression suite when Ubuntu package downloads are slow.

Two previous runs reached the old 25-minute job limit:

- [40320688470](https://github.com/alexj11324/Mikka/actions/runs/40320688470),
  commit `24126fc176ebe6d63d13dc93cdb731434f6d5a2d`: performance passed;
  68 functional passes were recorded before cancellation.
- [40324658490](https://github.com/alexj11324/Mikka/actions/runs/40324658490),
  commit `58bdf5df859f939bbc3f09abc0fb48b541988eb1`: installation ran from
  12:43:38 to approximately 12:53:06 UTC on 2026-10-26. Ubuntu reported fetching
  21.3 MB in 9 minutes 7 seconds. The build and five performance tests passed;
  80 functional passes were recorded before cancellation at 13:08:51 UTC.

Both checks explicitly reported exceeding 25 minutes. Neither incomplete run is
a full-suite success. The increased budget must be validated by a new complete run.

The official `playwright install --with-deps chromium` command remains unchanged.
[Playwright's CI guidance](https://playwright.dev/docs/ci) discourages browser
binary caching and notes that Linux OS dependencies are not cacheable; browser
caching would not address the measured system-package download delay.

PR scenario selection and performance timing now follow the layer policy above.
Assertions, performance thresholds, per-test and expectation timeouts, worker
count, and retry policy are unchanged. No alternative package
mirror is introduced. The total budget includes installation, build, tests and
artifact upload; it does not permit an individual test to run longer.
