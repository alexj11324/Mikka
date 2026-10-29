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
2. **Every push and pull request** (minutes, CI): production build, every unit
   test, database migrations and integration tests such as thread privacy.
   This is the gate review waits on.
3. **Ready pull requests** (CI job "Browser tests (before merge)"): critical
   browser flows plus the affected browser scenarios, against the PR merged with
   main. Draft PRs defer this layer. The trusted classifier on `main` chooses:

   | Change | Browser acceptance before merge |
   | --- | --- |
   | Documentation only | No browser runtime; the required gate confirms classification |
   | Source-only tests, CI workflows, CI policy and test-runner changes | Critical flows; selection-policy changes also validate both browser subsets |
   | Search, settings, Slack webhook paths | Critical flows plus complete relevant specs |
   | Schema-only migrations (`drizzle/*.sql`, with documentation) | Migration bootstrap and database checks, then critical flows |
   | Authentication, permissions, shared UI/runtime, dependencies, mixed schema and application changes, shared browser fixtures or unknown paths | Full functionality |

   The browser layer runs as parallel jobs: one build, one runtime-gate job
   (Factory HTTP, real HTTP authentication, MVP daemon and performance), two
   selection-validation jobs (critical and scoped subsets) and four regression
   shards. Every job has its own PostgreSQL service, test-account directory and
   artifact name, so no database, lease or fixture is shared concurrently. The
   build runs once and its `.next` artifact is reused; parallelism changes
   wall-clock time, not which assertions run.

   Critical flows cover anonymous redirects, registration/login, task creation,
   search/navigation, account isolation, and sign-out with server revocation.
   The scoped paths and complete spec lists live in `scripts/ci-docs-only.mjs`.
   Known browser spec changes include that spec; new specs and shared fixtures
   fall back to full functionality. Mixed changes take the union of scenarios
   or escalate to full. Unsafe file modes and unavailable comparisons also
   escalate. Pure CI policy changes run dedicated classifier/runner/gate tests,
   real HTTP authentication, critical browser flows and both actual browser
   subsets; they do not require full functionality or performance. The critical
   subset is not rerun after selection validation has already exercised it.
   During policy updates the workflow uses a fixed CI-only allowlist plus the
   trusted main classifier's documentation/mode checks; it cannot classify its
   own change as documentation-only. Any application or unknown file in that
   update escalates to full functionality. Failed classification or a
   skipped/failed selected test job fails the required gate.
4. **Integration** (CI): every code-bearing push to main, nightly on main, and manual
   Actions → Browser tests → Run workflow run full functionality **and** the
   desktop/mobile performance suite. Consolidation PRs on `integrate/` branches
   run both complete layers before merge as well. A PR changing a performance
   spec also runs performance before merge. Other PRs defer performance to integration;
   thresholds, assertions, worker count and retry policy remain unchanged.

A pull request that only changes documentation — non-executable Markdown in
`docs/` or `tasks/` (excluding nested `AGENTS.md`), root `AGENTS.md`, root README files, `LICENSE`, or
the pull request template — skips the heavy unit, build and browser jobs. The
required status checks report success from small gate jobs (also on a docs-only main push). Other changes
retain every source, production build, migration and database integration gate;
only browser scenario selection and performance timing are tiered. Test selection
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
