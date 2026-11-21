# Contributing to Mikka

Use this guide to prepare, verify and submit changes to Mikka.

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
  from a branch to `main` (local first, hot reload, ownership and merging, numbers,
  E2B dev templates) is in [`docs/dev-workflow.md`](docs/dev-workflow.md).
  Independently verifiable changes merge when their own checks and release
  window permit. Batch only genuine atomic dependencies; an existing epic's
  explicitly approved batch rules still apply. See the
  [delivery decision](docs/design/decisions/2026-11-20-1640-sdlc-delivery.md).
- Write commit messages in English, in the form `<type>: <description>`, where
  the type is one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`
  or `ci`.
- **Debug before requesting final CI.** Work in isolated cloud Linux, not on the developer's Mac. While editing, run the affected lint, type, unit, database and real API/CLI entry-point checks red→green; do not wait on GitHub Actions to discover ordinary HTTP, schema, generated-code or daemon failures. Push small commits to a Draft PR for recovery, and continue local debugging while its fast fail-closed checks execute. Before marking Ready, run `pnpm check`, an affected local build when needed, and the real changed-flow acceptance against isolated dependencies; record exact commands, exits and source. The final protected CI then independently verifies the candidate.

  ```sh
  pnpm install
  # During development: affected checks and local runtime/API/CLI red→green
  # Before Ready: complete the relevant local acceptance and pnpm check
  ```

- Work is assigned through a GitHub issue to one agent, who owns it end to
  end. Nobody pushes to `main` directly. The assigned agent opens a pull
  request from a branch and merges it itself with a merge commit (no squash,
  no rebase) once CI is green on the latest head and the PR is mergeable.
  After the merge the same agent verifies the exact merge SHA and records its
  regression and CI evidence. The release owner under #1954 stages and promotes
  verified artifacts; serving-version acceptance follows
  [`docs/dev-workflow.md`](docs/dev-workflow.md) § 5. CI evaluates GitHub's
  synthetic PR merge commit (the PR combined with its target branch) rather
  than just the standalone PR head. An unrelated merge to `main` does not
  require rebasing a still-mergeable PR. Read the effective branch protection
  and merge `main` normally into the PR when protection requires it, a conflict
  needs resolving or a relevant landed change needs integration verification.
  Reverify the updated candidate and preserve the existing protection settings.
  See "How changes are tested" below for which checks run when.
- Never commit credentials. Project secrets live in Infisical Cloud.
- Focus is stale-while-revalidate: only data past its freshness threshold
  revalidates, silently, never hiding what is shown; third-party status never
  on focus. See
  [`docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md`](docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md).

## Public core and Mikka Cloud ownership

This repository contains the independently runnable Mikka server, its clients
and the public contracts for optional Mikka Cloud services. Login, bots, threads,
devices, the built-in live gateway, user-supplied credentials and integration
setup must work without a Mikka account. Cloud connection settings and clients
that request scoped cloud services belong here too.

New services that hold Mikka's own credentials or act on behalf of other
deployments belong in the private `mikka-cloud` repository: cloud token issuance
and private signing keys, official GitHub App token brokerage and webhook
distribution, the Expo push relay, and cross-server model metering and billing.
Do not import or vendor that service into a public package. Its public protocol,
verification code and client-side errors may remain here without private keys.

Existing plugins, credential storage, billing, model routing and first-party
integration code remain public; this boundary does not move existing code.
See [the self-hosting design, § 8](https://github.com/alexj11324/Mikka/blob/804e0571a6d20c62e0be4c19c75d52444067de93/docs/design/self-hosting-cloud-services.md#8-代码放哪)
and [#1571](https://github.com/alexj11324/Mikka/issues/1571).

`pnpm check:cloud-boundary` runs the source policy and its positive/negative
fixtures. It is part of `pnpm check` and the required Source checks CI job.
The policy scans tracked and new source files, migrations and package manifests
for known private service primitives while allowing public client calls and
contracts. It catches accidental placement; reviewers still check new service
ownership and dynamically constructed implementations.

Retained first-party primitives have narrow exceptions in
[`scripts/cloud-boundary-policy.mjs`](scripts/cloud-boundary-policy.mjs), each
with an exact file, rule, fingerprint, count and reason. There are no whole-file
exceptions: a second primitive or a new private issuer in the same file fails.
Removing or changing a retained primitive also requires updating its stale
exception. Add an exception only for independently runnable or existing public
code, explain its ownership, and add a regression that keeps new cloud service
code rejected.

## How changes are tested

**Local change scope before CI.** Start with `pnpm local:plan` in the task's Linux development machine; it reuses the existing Nx/CI affected graph instead of adding a second test mapping. Execute focused existing package scripts with `pnpm local:check --test=<script>`, and use actual API/CLI/daemon/PG/UI acceptance for behavior changes. After commit, run `pnpm local:ready --test=<script> --accept=test:local-loop` (or `--report=<local-acceptance-report>`); for genuinely non-product changes, record `--no-product-change='tooling: <why>'` instead. `pnpm local:mark-ready --pr=<number>` verifies the saved exact-SHA local evidence before invoking `gh pr ready`. The evidence is ignored local metadata and cannot replace independent CI or truthful PR evidence. See `.agents/skills/local-first/SKILL.md` and the existing `docs/acceptance.md` for legitimate reuse and external-only exceptions.

Slow checks run less often and later. Each layer catches what the one before
cannot.

1. **Before pushing, use isolated cloud Linux.** Run the affected type, lint,
   and unit checks first. When the change affects a packaged runtime, build
   the affected artifact in that environment and test that same local build
   against isolated dependencies. Keep it off the registry and production
   traffic. Exercise the changed flow through the API and CLI with the local
   database and daemon when relevant. See the
   [development workflow](docs/dev-workflow.md).
2. **Ready pull requests, merge groups and main pushes** (CI, `ui-policy.yml`): trusted
   Nx Core selection runs affected unit, daemon and PostgreSQL suites plus the
   existing source/security policies. A Draft PR still runs its lightweight selector
   and named aggregate checks, which **fail explicitly** until Ready; it does not
   allocate the expensive Core, Integration, Source, Daemon or database runners.
   `ready_for_review` runs the full selected verification at the same source SHA.
   Ready PR checks use GitHub's synthetic merge candidate; the complete DB
   inventory is validated even when DB execution is not selected. Selected DB
   suites keep PG17 isolation, clone databases and strict no-skip summaries
   across 1–4 dynamic shards. Required gate names stay stable; every selected
   lane must succeed. Weekly and manual runs cover the full inventory.
   See the [selection, trust and fallback rules](docs/ci/incremental.md).
3. **Ordinary acceptance uses API and CLI.** Acceptance runs locally through
   the API and the CLI (`pnpm test:local-loop`), and UI changes are checked
   with screenshots of a local production build of the official UI (`pnpm build`, `pnpm start`, with `mikka-hosted-ui`). `browser-gate.yml` only keeps the protected
   check name "Browser tests (before merge)" and passes at once. The specs
   under `tests/e2e/` stay as retained fixtures. The general browser suite is
   retired. Targeted Desktop and Analytics jobs retain their
   explicitly selected build/browser checks. `site-search.yml` runs its
   spec with Playwright's request client. See the
   [workflow reference](.github/workflows/README.md) for actual scopes. Decisions
   [`design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md`](docs/design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md),
   [`design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md`](docs/design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md).
4. **Release from trusted artifacts.** GitHub Actions builds the official
   artifacts from reviewed source. Test the selected immutable artifact in
   Cloudflare staging before promoting that same digest. Run tests that need
   real provider credentials or Cloudflare behavior in this protected stage.
   See the [build source of truth](docs/operations/build-source-of-truth.md).

Documentation-only regular files retain a fast path after full DB inventory
validation. Unknown files, deletions/renames, mode changes, shared/security,
migration and CI configuration changes conservatively expand validation.
Classification and skip reasons appear in CI Summary; no PR-provided selector
can authorize its own skipped work. Details and inspection commands:
[Dependency-aware CI](docs/ci/incremental.md).

### Regression ownership and CI cost

Before adding a regression, identify the observable behavior, the failure it
must catch, its strongest production owner and why existing tests miss it.
Prefer one owner instead of redundant mocked replay, while retaining distinct
security, storage, API, protocol, migration and release contracts. Review
preserved evidence before deleting any test. See
[test ownership and CI cost](docs/ci/test-ownership.md).

### Draft PR checks

Keep work-in-progress pull requests as drafts to preserve independent pushed
checkpoints. On Draft source changes the required `CI` check **does run but
fails closed by design**, with expensive selected runner work deferred; GitHub
can treat an ordinary skipped required job as successful, so the required
aggregate check must never be skipped or shown green for a Draft. External
GitGuardian remains active. Standalone non-required HTTP, runtime, E2B,
search and SSH checks may also defer while drafting. Mark a PR **Ready for
review** only after local red→green, affected build and actual flow acceptance
are recorded: the `ready_for_review` event runs all applicable selected
protected checks on the same code SHA without a meaningless new commit.
Every applicable PR check must pass on the current head before merge.
Exact-version post-merge verification and protected staging and production
admission follow § 5 of the development workflow, with the existing release
owner and source-bound receipts.

### Before asking Alex: look at how leading products do it

A choice goes to Alex only when leading products (Linear, Slack, GitHub, Figma,
Claude, ChatGPT, Cursor, Devin and the like) disagree or the choice is about
Mikka's own strategy, money or brand. When they agree, follow them and record
which products in the PR. Details:
`docs/design/decisions/2026-11-01-0400-research-before-asking-alex.md`.

### One UI

Mikka has one UI ([decision](docs/design/decisions/2026-11-08-2133-one-ui.md)).
Fix a page where its code lives today: in this repository or in the private
`mikka-hosted-ui`. Don't add a slot or move code only to make a fix possible.
Paid component source (BoardUI Pro, affectUI, beUI Pro) never enters this
repository or its image; official builds bring it in. The build without it
only has to compile, so there is no separate open-source look to design,
screenshot or review. Official apps connect to Mikka Cloud or any self-hosted
server.

### UI changes: Figma, then skill review, then code

A change a person can see is drawn in Figma first, reviewed with the
`interface-design:design-review` and `unslop` skills until nothing blocking
remains, confirmed by Alex, and only then implemented. The PR shows the built
screen next to the confirmed frames; green CI alone does not make it
mergeable. Details: `docs/design/decisions/2026-11-01-0330-ui-figma-and-skill-review-before-code.md`.
A paid block or component (BoardUI Pro, affectUI, beUI Pro) is not redrawn or
skill-reviewed for look: it is used as shipped, and its PR attaches a
side-by-side of the library demo and our use
(`docs/design/decisions/2026-11-09-0050-paid-blocks-as-shipped.md`).

### Test logins: never ask for a password

For isolated local and CI HTTP/API tests, use the
[test-account lease pool](docs/test-accounts.md), which signs up or signs in
through the normal email flow and checks the application and database binding.
For production external-service acceptance, use the existing shared SMOKE
account in Alex's team workspace as [the acceptance rules](docs/acceptance.md)
describe. `AGENTS.md` identifies the authorized Infisical entries. Read them
through the existing authorized path and keep their values private.

Sessions never ask Alex for an account, password or verification code. Existing
authorization covers the shared acceptance account. A third-party consent under
Alex's own identity still follows the OAuth and account-ownership rules in
`AGENTS.md`.

Cloud machines use versioned Mikka templates derived from E2B's official
`desktop`, `claude` and `codex` templates. Node, the worker and its dependencies
are preinstalled under `/opt/mikka`. Add files, never delete or overwrite an
original official CLI, Node/npm or system file
([decision 2026-11-03-1430, clarified in #1505](docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md)).
A worker change on `main` runs the offline input checks in
`.github/workflows/e2b-official-runtime.yml`; publication starts from an eligible
Cloudflare serving observation or an authorized dispatch. The release requires
original-file conservation and build-time readiness on the exact candidates.
E2B uses the user's own key, so publication has no live subscription gate
([#2789](https://github.com/alexj11324/Mikka/pull/2789)). Retain published templates
and their immutable release reports for the release owner's rollback.
`e2b-template.yml` is the reusable candidate builder; production selection
belongs to the existing private Cloudflare deployment.
See [the release workflow](.github/workflows/README.md#cloud-worker-template-release)
and [`docs/dev-workflow.md`](docs/dev-workflow.md) § 7.

## Documentation

Start with the [documentation index](docs/README.md). Use the repository's
[`update-docs`](.claude/skills/update-docs/SKILL.md) checklist to identify pages
affected by a change and
[`technical-documentation`](.claude/skills/technical-documentation/SKILL.md)
to check their facts, structure and writing. Follow the existing language and
document ownership, including the design decision records.

Check commands and behavior against source, update corresponding English and
Chinese README sections together, and verify changed links and paths. Run
`git diff --check` before committing documentation. A source review or link
check establishes documentation consistency. Record any runtime verification
separately with its revision and environment.

## License

Mikka is copyright © 2026 Aspectly Labs and licensed under
[AGPL-3.0-only](LICENSE). Aspectly Labs also offers Mikka under separate
commercial license terms ([`NOTICE`](NOTICE)).

By intentionally submitting a contribution for inclusion in Mikka (a pull
request, a patch, or any code, documentation or asset), you agree that:

1. You keep the copyright in your contribution and license it under
   AGPL-3.0-only, like the rest of Mikka.
2. You also grant Aspectly Labs a perpetual, worldwide, non-exclusive,
   royalty-free and irrevocable license to use, copy, modify, distribute and
   sublicense your contribution, and to license it under other terms,
   including commercial licenses and later versions of Mikka's license.
3. You have the right to grant these licenses: the work is yours, or you are
   authorized to submit it, for example by your employer. You identify any
   third-party material and its license in your pull request.

There is no separate form to sign. When an agent prepares a contribution, the
person or organization that submits it makes these agreements. Send licensing
questions to [legal@aspectlylabs.com](mailto:legal@aspectlylabs.com).

## Security

Report vulnerabilities privately to
[security@aspectlylabs.com](mailto:security@aspectlylabs.com), not in a public
issue.
