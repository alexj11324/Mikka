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

- Branch from `main` and keep each pull request to one change. How work moves
  from a branch to `main` (local first, hot reload, trunk-based merging, module owners, numbers,
  E2B dev templates) is in [`docs/dev-workflow.md`](docs/dev-workflow.md).
- Write commit messages in English, in the form `<type>: <description>`, where
  the type is one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`
  or `ci`.
- Run the source-only checks before you push:

  ```sh
  pnpm install
  pnpm check
  ```

- Each pull request branches from `main`, changes one thing, and is
  squash-merged by the coordinator once CI is green
  ([`docs/dev-workflow.md`](docs/dev-workflow.md) § 5). Backend changes are
  Codex's; others ask first (the module owners table there). CI evaluates GitHub's
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

1. **While writing, locally** (the agent's cloud Linux container): `pnpm
   typecheck`, `pnpm lint`, the unit tests for what you changed, and the
   end-to-end acceptance of the flow you changed against `pnpm dev`, the
   daemon from source and the local database ([`docs/dev-workflow.md`](docs/dev-workflow.md)). CI is the
   final gate; do not wait on it, a merge or a deploy to check what you can
   check here.
2. **Every pull request and push to main** (minutes, CI, `ui-policy.yml`):
   unit tests, lint, type checks (in "Source checks"), daemon checks,
   database migrations and integration tests such as thread privacy. PR checks
   run against GitHub's synthetic merge candidate. Same-repository branch pushes
   without a PR do not run a duplicate blocking suite. Database suites are
   partitioned across four isolated PostgreSQL jobs; every shard validates the
   complete inventory before running its share sequentially, and the protected
   gate "Production build and browser interactions" requires every shard to
   succeed. CI runs no production build: Vercel builds `main`, and a failed
   build there leaves production on the last good deployment and is fixed
   forward. Vercel does not build pull requests.
3. **No browser tests**, in CI or locally. Acceptance runs locally through
   the API and the CLI (`pnpm test:local-loop`), and UI changes are checked
   with screenshots of a local production build (`next build`, `next start`). `browser-gate.yml` only keeps the protected
   check name "Browser tests (before merge)" and passes at once. Decision:
   [`design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md`](docs/design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md),
   [`design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md`](docs/design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md).

A pull request that only changes documentation — non-executable Markdown in
`docs/` or `tasks/` (excluding nested `AGENTS.md`), root `AGENTS.md`, root README files, `LICENSE`,
the pull request template, or the README diagrams (`docs/assets/*.svg` and their generator scripts) — skips the unit and
database jobs. The required status checks report success from small gate jobs
(also on a docs-only main push). Other changes retain every source, migration
and database integration gate. Test selection is printed in the Changed files
job and its summary.

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
signed in, take an account from the test-account lease pool
(`scripts/test-accounts/session.mjs`; `docs/test-accounts.md`), which signs up
or signs in through the normal email flow. Only a click on a third-party site
under Alex's identity (a GitHub App install, an OAuth consent) or a session
permission prompt may be asked of him. The named accounts set up outside the
pool: `docs/design/decisions/2026-11-01-0300-agents-inject-test-logins.md`.

The cloud worker's E2B template is released by CI, not by hand: a push to `main` that
changes a path the template packages (`WORKER_PATHS` in `scripts/e2b/build-template.py`)
or `scripts/e2b/` runs `.github/workflows/e2b-template.yml`, which builds the template,
makes it public, sets `E2B_BYO_COMPUTER_TEMPLATE` and `MIKKA_CLOUD_WORKER_SHA` together
in Vercel Production and redeploys. To test worker changes before that, build a
`-dev` template from the branch with the same script and point only your local
or test environment at it; never overwrite the production template or Vercel's
production variables ([`docs/dev-workflow.md`](docs/dev-workflow.md) § 7).

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
