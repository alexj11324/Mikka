# Dependency-aware CI

Mikka uses pinned Nx Core 24.0.5, Node 24 and pnpm 10.34.3. Nx Cloud and remote
caching are disabled. The initial implementation does not cache test results:
real PostgreSQL, credentials, subscriptions, migrations and release acceptance
must execute. Installed dependencies use exact, platform-bound caches with a
pnpm-store fallback; only main pushes and manual main runs write them. See
[dependency reuse and scheduling](1765-optimizations.md).

## Projects and dependencies

No product code moved. `scripts/ci/graph.mjs` creates explicit file projects for
root sources and package contents, package consumers, virtual unit commands and
DB suite consumers. `scripts/ci/tasks.json` is the reviewed inventory of commands
previously run by the core/integration jobs. The real `ci-tasks` project exposes
these as Nx targets so Nx schedules the selected commands with two parallel tasks
per runner. Commands retain Actions `bash -e -o pipefail` behavior and set
`FORCE_COLOR=0`: Nx otherwise colors child numeric PID/CLI output, breaking
machine parsing in real process-tree regressions. DB suites remain exclusively with `scripts/run-db-tests.mjs`.

TypeScript's parser follows imports/exports, literal dynamic imports and requires,
relative imports, root `@/`, Mobile's own `@/`, `@ui-slot/` and workspace package
imports. Workspace package imports conservatively depend on the package sources.
Literal filesystem/source-contract paths and command globs add test edges.
DB `REQUIRED_SUITES` markers add explicit source-to-suite edges independently of
imports, so deleting a test cannot remove its enrollment requirement.

| Change | Selection / reason |
| --- | --- |
| Mobile-only | Mobile consumers, source policies/typechecks; no unrelated DB, daemon or native desktop |
| Web components/hooks | Import and source-contract consumers plus source policies; no unrelated DB |
| Daemon | Package and imported consumers, daemon tests, required downstream contracts |
| API/Factory/Coordinator | Reverse source closure and mapped DB suites; server path without DB proof runs all DB |
| Protocol/shared, migrations, DB core, permissions, auth | Full validation |
| Workflow/action, selector, test helpers, lock/workspace/build configuration | Full validation |
| Unknown path, deletion/rename, mode change, failed parse or graph | Full validation; inventory failure is red |
| Docs-only regular files | Inventory only, then stable skipped-work gates |
| main push | Same selection on the exact before/after SHA; release waits for that exact successful CI run |
| Dispatch / weekly integration | Full validation |

Shared backend dependencies can legitimately reach many suites. For example,
`test:account-db` contains `workspace-teardown.db.test.ts`, which imports
`thread-machines.ts`, which imports `factory/store.ts`. That account suite remains
selected for a Factory store change. Test mocks and runtime-generated imports
are not used to prune transitive dependencies. Generated/unresolved imports on a
changed file force full coverage. Unmapped server coverage uses all DB suites.
Filesystem-scanning i18n and generated-catalog checks are unconditional source
policies too: message files and discovered UI entries do not appear as literal
imports in those scanners. The source job still runs the existing whole-repository typecheck/lint and API /
frontend source tests; this is deliberate retained coverage, not a performance
claim.

Site search runs the full root typecheck once through its existing `pnpm build`,
before compiled HTTP acceptance. Its earlier preparation step retains generated
route verification and lint. The same build/typecheck remains required on a
standalone dispatch. Both PostgreSQL 17 services, Better Auth, authorization and
HTTP assertions retain their independent runtime coverage. The separate Source
checks job still owns unconditional repository-wide static validation; results
from a different runner image or Node patch are not treated as identical-input
cache hits. See the [recorded before sample](2984-site-search-checks.json).

## Trust and database boundaries

CI calls `ci-selection.yml` once, then passes `selected: true` to each selected
Desktop, Analytics or Image reusable workflow. Those calls skip their duplicate
selector job. Independent dispatches and Image pushes still call the selector.
It fetches main and loads `bootstrap.sh` from there.
The bootstrap archives the immutable PR base (or merge-group base / previous main
commit) only after proving it belongs to main history; otherwise it uses current
main policy and forces full validation. An unmerged target branch cannot provide
its own policy. It installs only those trusted manifests with lifecycle scripts disabled.
The trusted selector parses candidate files as data. It never imports a candidate
plugin or executes candidate configuration. Forks use the same path without
secrets. The tested checkout remains GitHub's synthetic merge candidate; the
classification diff uses the PR base/head SHAs. Unsupported events/ranges run all.

A frozen dependency branch can retain an older command inventory after main's
registry changes. In the unmerged-base fallback, a candidate with main's complete
registry keeps the normal main-policy path. For a different registry, the current
trusted selector proves a unique common ancestor in the fetched main history and
reads that ancestor's registry as JSON. The base and tested checkout must retain
its complete CI configuration, manifests, runner and plugin bytes. Test paths and
Git modes must match, including TypeScript type tests and Go tests; working files
must match the committed checkout. Existing self-hosted dependency declarations
cannot be changed or removed; appended declarations still pass the normal
self-hosted acceptance checks. Same-name test bodies can change as part of the
reviewed backport. The proof preserves task names, commands, kinds and environments,
and selects every task in that registry with full validation of all other lanes
and the entire candidate DB inventory. It never executes the ancestor's selector,
trusts a branch-name allowlist, drops unknown tasks or converts a failed proof to
a partial selection. The selection report records the policy, ancestor and registry
blob identities. The original runner still rejects unknown tasks.

When introducing the selector on a base that predates it, inventory is validated
with the old trusted runner and every lane runs in full. Candidate shadow reports
have no job outputs and cannot authorize skips.

New database-named or driver-importing tests outside the legacy scan roots are rejected until explicitly enrolled; existing MTS files named by enrolled suite commands remain covered. Every classification builds and validates the **entire** DB inventory, even when
no DB job is needed. Each DB worker validates it again. `DB_TEST_SELECTED` must
be a unique, nonempty subset of the complete enrollment; an explicit empty set
is an error in the runner. Only a trusted decision can skip the whole DB job.
Selected suites are sorted and assigned disjointly to 1–4 shards (up to eight
suites per runner until the four-shard cap). The existing PG17 service, template
clones, template-bound serial lane, bootstrap, target binding, no skips/todos and
TAP summary reconciliation remain intact. The first selected shard retains local
runtime identity and thread privacy integration tests.

Required status names remain `UI policy (strict)`, `Production build and browser
interactions`, `Browser tests (before merge)` and external GitGuardian. Gates
check each selected lane must succeed and each unselected lane must be skipped;
failure, timeout, cancellation, missing output or unexpected skip cannot pass.
Selected Analytics runs as a reusable CI job, and its conclusion feeds `UI policy (strict)`. Desktop keeps its separate acceptance workflow. No workflow-level path filter is added to required workflows. Main concurrency,
OIDC, daemon/Desktop exact-source CI gates, E2B release pairs and publication
checks are unchanged. Existing browser-gate remains a compatibility status only;
this change adds no browser tests.

## Inspect and verify

```sh
pnpm exec nx show projects --json
pnpm exec nx graph --file=/tmp/mikka-graph.html
CI_BASE=origin/main CI_HEAD=HEAD node scripts/ci/select.mjs
node scripts/ci/shadow.mjs
node --test scripts/ci/*.test.mjs scripts/run-db-tests.test.mjs scripts/ci-docs-only.test.mjs
# Run selected pure commands (no Nx or remote result cache):
CI_UNITS='["ci-core-triage"]' node scripts/ci/run-units.mjs core
# Collect actual completed Actions metadata; no credential values are printed:
CI_TIMINGS_FILE=/tmp/timings.json node scripts/ci/timings.mjs RUN_ID_1 RUN_ID_2
```

CI prints areas, reasons, Nx affected projects/commands, suites and shard matrix.
The stable gates record the final selected-job conclusion plus completed job
durations from read-only Actions metadata. Each gate reads its own
`GITHUB_RUN_ATTEMPT`; the collector reads the latest attempt and paginates that
attempt's jobs. Both use the attempt endpoint's `created_at` for elapsed and
initial queue time. The receipt keeps the original run's `run_created_at` and
`run_lifetime_seconds` separately, including earlier attempts and time before a
retry. Per-job queue time starts at that job's `created_at`, excluding dependency
wait. A successful job retained by a failed-job retry keeps its original
timestamps and `retained_seconds`, with zero new execution and no new queue time.
Only jobs executed in the measured attempt contribute to runner-minutes.

The timing summary labels partial runner consumption while other gates/jobs are
still running; API failures explicitly leave timing unavailable, without
replacing enforcement. Job/step timestamps
are available through the timing collector; [#1699's evidence](1699-results.md)
separates waiting from runner consumption. `workflow_dispatch` and Monday 03:23
UTC run the full CI even without source changes.

Rollback is a revert PR restoring the former full workflow and removing the
selector consumers. No schema, production settings or protected-check changes
are needed. If uncertain, forcing full validation is safe; relaxing inventory or
a release gate to recover performance is not.
