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
3. **Before merging into main** (CI job "Browser tests (before merge)"): the
   full browser suite (Playwright, functionality and performance). It runs on
   a pull request once it is ready for review, and again on every push while
   it stays ready, against the PR merged with the latest main, so two changes
   that each pass but break together are caught. Keep a PR as a draft while it
   is in progress to skip it. To run it on a branch without a PR, start CI by
   hand: Actions → Browser tests → Run workflow.
4. **After merging** (CI): the same suite on main, and again every night.

A pull request that only changes documentation — non-executable Markdown in
`docs/` or `tasks/` (excluding `AGENTS.md`), root README files, `LICENSE`, or
the pull request template — skips the heavy unit, build and browser jobs. The
required status checks report success from a small gate job. Code, executable
files, generated assets, diagram scripts, workflow, configuration, message and
public-asset changes run the full suites; one other file is enough.

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
