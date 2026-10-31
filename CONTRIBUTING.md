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

- A pull request merges once the required checks pass. See "How changes are
  tested" below for which checks run when.
- Never commit credentials. Project secrets live in Infisical Cloud.

## How changes are tested

Slow checks run less often and later. Each layer catches what the one before
cannot.

1. **While writing** (seconds, on your machine or the agent's container):
   `pnpm typecheck`, `pnpm lint` and the unit tests for what you changed. Run a
   browser test only for the flow you changed, and only if you can.
2. **Every push and pull request** (minutes, CI): every unit test, lint, type
   checks, database migrations and integration tests such as thread privacy.
   This is the gate review waits on. The production build runs in the browser
   job of a ready pull request, and on main, the merge queue and fork PRs.
3. **Ready pull requests** (CI job "Browser tests (before merge)"): the browser
   smoke set plus the specs of the areas the change touches, against the PR
   merged with main, in one job ("Browser tests (pull request)": install, build,
   start, run). Draft PRs defer this layer. The trusted classifier on `main`
   chooses:

   | Change | Browser acceptance before merge |
   | --- | --- |
   | Documentation only | No browser runtime; the required gate confirms classification |
   | Any other change | The smoke set: the tests tagged `@smoke` (about ten) and the first MVP real-daemon test, plus the Factory HTTP, real HTTP authentication and test-account gates |
   | Mapped paths (search, settings, Slack, Factory, threads, suggestions, devices, auth, relations, active agents) | Smoke plus the complete specs of each touched area |
   | An edited spec under `tests/e2e/` | Smoke plus that complete spec |
   | Paths the performance budgets measure (navigation shell, settings, saved history) or a performance spec | Also the desktop/mobile performance suite |
   | Selection-policy changes (classifier, runner, this workflow) | Also "Browser selection validation": every scoped spec as one real subset |
   | Unsafe file modes, unavailable comparisons, `integrate/` branches | The full tier (below) before merge |

   The smoke set covers anonymous redirects, sign-up (with Cloudflare's public
   Turnstile test keys once the form sends a token), task creation, account
   isolation, a settings save, Factory acceptance and approval, device
   authorization, share revocation, an approval card and the real daemon loop.
   The tags live in the specs; the area map, the main list and the nightly-only
   list live in `scripts/ci-docs-only.mjs`, and every spec file is in exactly one
   of the main or nightly-only lists. During policy updates the workflow uses a
   fixed CI-only allowlist plus the trusted main classifier's documentation/mode
   checks; it cannot classify its own change as documentation-only, and any
   other file escalates to the full tier. Failed classification or a
   skipped/failed selected job fails the required gate.
4. **After merge** (CI, every code-bearing push to main): the functional spec
   files (the main list) on two shards, plus the runtime gates and both MVP
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
   tier.

A pull request that only changes documentation — non-executable Markdown in
`docs/` or `tasks/` (excluding nested `AGENTS.md`), root `AGENTS.md`, root README files, `LICENSE`, or
the pull request template — skips the heavy unit, build and browser jobs. The
required status checks report success from small gate jobs (also on a docs-only main push). Other changes
retain every source, migration and database integration gate and a production
build (in the pull request browser job, and in "Production build and browser
interactions" on main, the merge queue and fork pull requests); only browser
scenario selection and performance timing are tiered. Test selection
is printed in the Changed files job and its summary. The browser environment
remains an isolated PostgreSQL service and the built application on the GitHub
Linux runner's localhost; this workflow does not test a Vercel Preview.

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
