# CI dependency reuse and scheduling (#1765)

This guide describes the dependency and runner changes following the
[five-scenario #1699 measurements](1699-results.md). The owner records Git-linked
cold/warm runs and merge/deployment evidence in
[issue #1765](https://github.com/alexj11324/Mikka/issues/1765). The historical
report remains unchanged; these changes do not establish a five-minute p50 or
ten-minute p95 service level.

## Runner scheduling

CI runs its trusted selector once. Selected Desktop, Analytics and Image calls
receive `selected: true`, skipping their nested selector. A standalone dispatch
or Image push retains trusted classification and conservative full coverage.

Desktop's macOS job does not consume Linux smoke output. It starts independently
and retains its own ARM64 backend build, disposable database, packaged integrity,
Keychain and functional acceptance. Icon compilation runs first on that same
macOS runner, replacing the separate icon job. Linux smoke, static checks and
native acceptance all contribute to the reusable workflow conclusion and the
unchanged `UI policy (strict)` gate. A failing lane cannot be replaced by another
lane's success.

This removes one macOS runner allocation, up to three nested selector allocations
for a full CI run, and the Linux-smoke dependency on the native critical path.
Public GitHub runner capacity still controls external queue delays; no paid
runners or persistent pool are added.

## Installed dependencies

The shared `.github/actions/pnpm-install` action uses pinned pnpm 10.34.3 and
Node 24. It restores installed dependencies only on an exact key match. The key
includes tracked manifests, lockfile, workspace configuration, npm configuration,
patches and installer implementation, plus Node/pnpm versions, OS image family,
architecture, checkout path, installation profile, Electron download mode and
`NODE_ENV`. Application source edits do not invalidate this cache.

An exact hit skips installation. A miss restores the existing pnpm store when
available and runs a frozen-lockfile install. A partial module key is never
accepted. Workspace lifecycle hooks or a pnpmfile hook disable installed-module
reuse, because they can read arbitrary source inputs. The trusted selector keeps
its separate immutable-base, `--ignore-scripts` installation; it never loads
candidate installed dependencies.

Only `push` or `workflow_dispatch` on `refs/heads/main` saves caches. Saving runs
immediately after installation, before tests, builds or later credential setup
can modify dependencies. PRs restore without uploading. Desktop uses the
`desktop` profile, excluding `@mikka/mobile`, and skips the Electron download
during pnpm setup. Runtime lanes still run the pinned, checksum-verifying
Electron installer on every job. Tests, signed packages, database state and
acceptance results are not cached. Release workflows and their gates are unchanged.

The first main run for a new key pays installation and cache-upload costs.
`ci-dependencies.yml` warms the macOS and Desktop Linux keys on main when
installation inputs change; ordinary main CI populates the full Linux tree.
Manual dispatch can repopulate evicted keys or warm a changed runner/tool image.
Later PRs restore those default-branch entries. Cache eviction or a changed
runtime returns to the frozen-install path. Monitor cache transfer time and
size against installation savings; package-store hits alone still rebuild the
installed dependency tree. Each install saves at most one archive: reusable
module trees normally, or the package store when workspace hooks disable reuse.
Existing store entries remain a fallback on misses, avoiding duplicate uploads
of both large trees.

## Measure the result

The [local dependency receipt](1765-dependencies.json) compares the same Desktop
profile with an empty store, a restored store and restored installed modules:

| Local Linux setup | Archive MB (decimal) | Restore seconds | Install seconds |
| --- | ---: | ---: | ---: |
| Empty store | — | — | 39.908 |
| Restored pnpm store | 818.1 | 4.639 | 4.998 |
| Restored installed dependencies | 708.4 | 5.188 | 0 |

This single sample uses Node 24.19.0, pnpm 10.34.3 and zstd archives. The restored
native/tool packages load successfully. It excludes GitHub transfer and queues,
and does not cache Electron runtime acceptance. Installed modules reduce local
setup from 9.637 to 5.188 seconds and archive size by 13.4% relative to the store;
these numbers do not predict macOS or end-to-end PR timing.

Collect completed runs with the existing command:

```bash
CI_TIMINGS_FILE=/tmp/ci-timings.json node scripts/ci/timings.mjs RUN_ID
```

Replace `RUN_ID` with a numeric Actions run ID. The collector pins the reported
attempt and includes workflow wall time, runner-minutes, job-created-to-start
intervals, job timestamps and named step durations. Workflow wall time includes
queueing and uses the latest completion, rather than adding parallel waits.
GitHub's job-created-to-start interval is distinct from waiting for predecessor
jobs. Compare dependency restore/install and cache-upload steps separately.

The #1699 web native job
[128606612928](https://github.com/alexj11324/Mikka/actions/runs/42439196351/job/128606612928)
spent 142 seconds installing dependencies and 162 seconds in setup-node's
post-job cache upload, within a 1042-second job. Its native backend build took
181 seconds and functional acceptance took 417 seconds. These are historical
measurements, not promised savings: runner load, patches and tool versions differ.

Validate both cold and warm runs. Record exact SHAs, platform, dependency key,
cache hit/miss, transfer time and all selected check conclusions. Reuse cannot
turn a failed, cancelled or skipped required acceptance into a pass. The focused
regressions run under `node --test scripts/ci/*.test.mjs` in the existing CI task.

The cache implementation follows the official
[actions/cache scope and restore/save documentation](https://github.com/actions/cache/tree/v4#cache-scopes).
