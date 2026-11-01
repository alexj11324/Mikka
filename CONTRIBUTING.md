# Contributing to Mikka

Thank you for helping improve Mikka.

## Before you start

- Read [`AGENTS.md`](AGENTS.md). Its rules apply to every contributor, human or
  coding agent.
- For design, spec or UI work, start with
  [`docs/design/README.md`](docs/design/README.md) and use the terms in
  [`docs/design/glossary.md`](docs/design/glossary.md).
- For anything larger than a small fix, open an issue first so the approach can
  be agreed before you write code.

## Pull requests

- Branch from `main` and keep each pull request to one change.
- Write commit messages in English, in the form `<type>: <description>`, where
  the type is one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`
  or `ci`.
- Run the source-only checks before you push:

  ```sh
  pnpm install
  pnpm check
  ```

- A pull request merges once the required checks pass. CI evaluates GitHub's
  synthetic PR merge commit (the PR combined with its target branch) rather
  than just the standalone PR head. An unrelated merge to `main` does not
  require rebasing a still-mergeable PR; a real conflict must be resolved and
  the updated candidate reverified. The GitHub branch protection setting
  "Require branches to be up to date before merging" must be disabled for
  this loose-check policy; the workflow alone cannot change that setting.
  See "How changes are tested" below for which checks run when.
- Never commit credentials. Project secrets live in Infisical Cloud.
- Focus is stale-while-revalidate: only data past its freshness threshold
  revalidates, silently, never hiding what is shown; third-party status never
  on focus. See
  [`docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md`](docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md).

## How changes are tested

Slow checks run less often and later. Each layer catches what the one before
cannot.

1. **While writing** (seconds, on your machine or the agent's container):
   `pnpm typecheck`, `pnpm lint` and the unit tests for what you changed. Run a
   browser test only for the flow you changed, and only if you can.
2. **Every pull request and push to main** (minutes, CI): unit tests, lint, type
   checks, database migrations and integration tests such as thread privacy.
   PR checks run against GitHub's synthetic merge candidate. Same-repository
   branch pushes without a PR do not run a duplicate blocking suite.
   Each ordinary ready-PR browser lane builds its exact checkout; main and full
   tiers share one browser build. Merge-group events retain a build in source CI.
   Source checks, two source-test groups and daemon acceptance run independently. Database
   suites are partitioned across four isolated PostgreSQL jobs; every shard
   validates the complete inventory before running its share sequentially, and
   the protected gate requires every shard to succeed.
> Browser tests (items 3–5) are manual only since 2026-11-01
> (`docs/design/decisions/2026-11-01-0230-browser-tests-manual-only.md`). The
> check "Browser tests (before merge)" passes at once; CI runs no production
> build; Vercel builds `main`.

3. **Ready pull requests** (CI job "Browser tests (before merge)"): the browser
   smoke set plus the specs of the areas the change touches, against the PR
   merged with main. Two "Browser tests (pull request)" lanes start directly,
   each building the same checkout with its own PostgreSQL database and test
   identities: the browser lane runs smoke/targeted tests and Turnstile; the
   runtime lane runs HTTP/account checks, the first MVP real-daemon test and any
   required performance checks. Draft PRs defer this layer.
   The trusted classifier on `main`
   chooses:

   | Change | Browser acceptance before merge |
   | --- | --- |
   | Documentation only | No browser runtime; the required gate confirms classification |
   | Any other change | The smoke set: the tests tagged `@smoke` (about ten) and the first MVP real-daemon test, plus the Factory HTTP, real HTTP authentication and test-account gates |
   | Mapped paths (search, settings, Slack, Factory, threads, suggestions, devices, auth, relations, active agents) | Smoke plus the complete specs of each touched area |
   | An edited spec under `tests/e2e/` | Smoke plus that complete spec |
   | Paths the performance budgets measure (navigation shell, settings, saved history) or a performance spec | Also the desktop/mobile performance suite |
   | Browser mapping data (`scripts/ci-browser-map.json`) | Smoke plus affected specs; mapping additions/removals add their old/new specs without reducing trusted-main coverage |
   | Executable selection-policy changes (classifier, runner, this workflow) | Also "Browser selection validation": every scoped spec partitioned across four isolated subsets, each retaining the smoke tag |
   | Unsafe file modes, unavailable comparisons, `integrate/` branches | The full tier (below) before merge |

   The smoke set covers anonymous redirects, sign-up (with Cloudflare's public
   Turnstile test keys once the form sends a token), task creation, account
   isolation, a settings save, Factory acceptance and approval, device
   authorization, share revocation, an approval card and the real daemon loop.
   The tags live in the specs; the area map, the main list and the nightly-only
   list live in `scripts/ci-browser-map.json`, and every spec file is in exactly one
   of the main or nightly-only lists. Update that JSON when adding an area or
   assigning a new spec to a tier. During policy updates the workflow uses a
   fixed CI-only allowlist plus the trusted main classifier's documentation/mode
   checks; it cannot classify its own change as documentation-only, and any
   other file escalates to the full tier. Mapping data is parsed as JSON, never
   executed; only trusted-main code can choose a narrower tier. Main/full runtime,
   full browser shards and policy-validation jobs reuse their exact candidate build.
   Failed classification or any skipped/failed required lane fails the gate.
4. **After merge** (CI, every code-bearing push to main): the functional spec
   files (the main list) on four shards, plus the runtime gates and both MVP
   tests. A red run opens one issue (or comments on the open one) that names the
   merged pull request's author, who fixes forward or reverts within one working
   day; the issue closes on the next green main run.
5. **Nightly** (19:17 UTC) and manual Actions → Browser tests → Run workflow:
   every spec, including visual/layout, the click crawler, slower edge cases
   and specs waiting to move to component or HTTP tests, plus the
   desktop/mobile performance suite, on four shards. Thresholds, assertions,
   worker count and retry policy are unchanged; moving a spec to a later tier
   never skips it.

   Each sharded job has its own PostgreSQL service, test-account directory and
   artifact name, so no database, lease or fixture is shared concurrently. The
   evidence scanner audits every log and report before any upload, in every
   tier. Build jobs restore only Next's incremental `.next/cache`; successful
   main builds seed that cache for later PRs. Runtime artifacts exclude the
   build cache and retain the application built for the exact tested revision.

A pull request that only changes documentation — non-executable Markdown in
`docs/` or `tasks/` (excluding nested `AGENTS.md`), root `AGENTS.md`, root README files, `LICENSE`,
the pull request template, or the README diagrams (`docs/assets/*.svg` and their generator scripts) — skips the heavy unit, build and browser jobs. The
required status checks report success from small gate jobs (also on a docs-only main push). Other changes
retain every source, migration and database integration gate and a production
build (in browser CI for pull requests and main, and source CI for merge-group
events); only browser
scenario selection and performance timing are tiered. Test selection
is printed in the Changed files job and its summary. The browser environment
remains an isolated PostgreSQL service and the built application on the GitHub
Linux runner's localhost; this workflow does not test a Vercel Preview.

### Before asking Alex: look at how leading products do it

A choice goes to Alex only when leading products (Linear, Slack, GitHub, Figma,
Claude, ChatGPT, Cursor, Devin and the like) disagree or the choice is about
Mikka's own strategy, money or brand. When they agree, follow them and record
which products in the PR. Details:
`docs/design/decisions/2026-11-01-0400-research-before-asking-alex.md`.

### UI changes: Figma, then skill review, then code

A change a person can see is drawn in Figma first, reviewed with the
`interface-design:design-review` and `unslop` skills until nothing blocking
remains, confirmed by Alex, and only then implemented. The PR shows the built
screen next to the confirmed frames; green CI alone does not make it
mergeable. Details: `docs/design/decisions/2026-11-01-0330-ui-figma-and-skill-review-before-code.md`.

### Test logins: never ask for a password

Sessions never ask Alex for an account, password or login step. To test
signed in, create the login yourself: hash a random password with
`better-auth/crypto`'s `hashPassword`, insert a `credential` row into `account`,
store the email and password in Infisical (the database's environment), and
check it through `POST <base>/api/auth/sign-in/email`. Only a click on a
third-party site under Alex's identity (a GitHub App install, an OAuth consent)
or a session permission prompt may be asked of him. Details and the current
test accounts: `docs/design/decisions/2026-11-01-0300-agents-inject-test-logins.md`.

## License

Mikka is licensed under [AGPL-3.0-only](LICENSE). Contributions are submitted
under the same license; contributors retain copyright in their work. No separate
contributor agreement or copyright assignment is required. Please only submit
work you are authorized to license under AGPL-3.0-only, and identify any
third-party material and its license in your pull request. Send licensing
questions to [legal@aspectlylabs.com](mailto:legal@aspectlylabs.com).

## Security

Report vulnerabilities privately to
[security@aspectlylabs.com](mailto:security@aspectlylabs.com), not in a public
issue.
