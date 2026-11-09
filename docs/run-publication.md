# Run result publication

This delivery connects a run's pushed task branch to an issue PR and the
Coordinator's existing conversation. Cloud queue/runtime are unchanged.

## Assignment

`prepareRunPublication` pins the existing task identifier to ADR 0024's exact
`mikka/<team>-<number>` branch. It uses `taskIdentifiers`; it never invents a
team, adds an identity suffix, or changes the branch on a retry. A transaction
reserves `(remoteKey, branch)` across issues, so two users whose personal tasks
have the same identifier cannot push into each other's task branch.

Repository identities use the `v2/` namespace. Only GitHub's standard HTTPS and
`git` SSH endpoints share a cross-transport identity. Other hosts retain their
port, SSH user, absolute/relative namespace, path case and literal suffix. SSH
URLs must state the login user; a machine's implicit OS login is not a shared
repository identity.
Daemon clone directories use a digest of that identity, including on
case-insensitive filesystems. An existing scheduling record never changes its
clone URL when another request registers an alias or a different repository.

Old identity keys, approvals and publication receipts are preserved but are not
adopted or rewritten. A queued legacy or mismatched binding is refused; schedule
a new thread for the current repository identity. Only old
GitHub physical-checkout records with a verified equivalent endpoint can reuse
their record ID, without changing the clone URL. No data migration grants a push.

Pushing needs no approval in Mikka
([decision](design/decisions/2026-11-02-1600-agents-use-own-github-credential.md)):
every run works with its owner's own GitHub credential, the same as
`gh auth login` on their own computer, for every repository they authorized.
There is no push grant, no push card and no first-push approval per
repository. Admission binds the task to its repository and branch only: new
receipts carry `authority: 'owner_credential'`; older `github_app` and
`repository_approval` receipts still match, and `configured_allow` receipts do
not. A stored `git_push` and the 创建 Pull Request setting stay readable but
gate nothing. `repository_settings.push`, its old pending cards and
`github_repository_installations.pushGrantedAt` are history nobody reads.

Claim sends `pushBranch` and `policy.permissions.git_push`: `allow` when the
run has a task branch, so the daemon may push that branch itself for a run
whose agent does not deliver it. For every github.com run of an owner with a
GitHub connection, claim also sends `github` (the credential endpoint and the
run's repository; `branch` only for a writable implement or fix run with a task
branch). The daemon uses the same credential for its own clone and fetch, with
no force push.

A cloud (E2B) run follows the same rule: a writable github.com run gets its
task branch and publication when it is queued, and the same credential.

A read-only run (`dispatch_run` with `readOnly: true`: an investigation or
review) keeps the credential like any run; readOnly is task intent only. Its
worktree is not writable, it gets no task branch or publication, ends
`succeeded` with its report and publishes nothing.

When admission refuses a run, the error is `runInvalid` with a `reason` and a
sentence the Coordinator acts on (`lib/run-invalid-reason.ts`).

## Completion and retries

The first completion, worker-token revocation, issue/history changes and final
Coordinator event are transactional. The accepted report is immutable. Replayed
completions do not reopen an issue or overwrite later user edits.

A `run_publications` receipt survives function restarts. The completion endpoint
waits for durable Vercel Workflow enqueue before returning 204; an enqueue error
returns 503 so the daemon outbox retries. Duplicate workflows share a database
lease. GitHub transient failures retry at most five publishing attempts; exhausted
infrastructure retries enter a final failure step and report a safe result.

`verify: passed` can create an open PR. When there is no configured verification
command, the daemon snapshots the real submitted tree, retains `verify: not_run`,
and may commit and push its task branch. Without a matching, actually pushed
result the thread stays stopped/unverified and the task is not advanced to
review. After a successful push the server
requests a draft PR and tells the Coordinator that human checking remains.
A failed verify never publishes. A Factory execute attempt leaves final
readiness to its independent review/verify path and preserves an existing PR
readiness state when execution had no preconfigured verification command
(`publishRunResult` in `lib/run-publications.ts`). A harness's self-reported verification is
discarded in every path.
Alex approved this missing-verification behavior on 2026-10-28.

The GitHub client reuses an existing task-marked PR. An unverified continuation
converts that task's open PR to a draft before recording its result. It never
automatically reopens a closed PR or marks a draft ready for review.

## GitHub ownership and permissions

The server opens or adopts the pull request through `githubMachineCredential`
(`lib/github/machine-credential.ts`). A saved self-owned App is selected first,
then an explicitly linked Mikka Cloud capability, then the legacy OAuth
connection. User tokens check GitHub `/user` against the linked account. Cloud
installation tokens check the target repository in `/installation/repositories`.
See [GitHub through Mikka Cloud](self-hosting-github-cloud.md).
Publication receipts, workflow arguments, logs and user-facing publication
responses contain no GitHub token. Without a
connection the result is `github_identity_required`; a token GitHub refuses is
`github_reconnect_required`.

The API origin is fixed to `https://api.github.com`, redirects are disabled, and
fetch errors become fixed safe error codes. A reported commit must match the
actual pushed branch SHA. Before creating a PR, and after an ambiguous timeout or
422, the client finds the existing PR by head and the issue UUID footer. A human's
unrelated PR is not adopted. Existing PRs return their actual open/draft/merged/
closed state.

A successful link is added to issue `pullRequests` without replacing unrelated
metadata, increments the issue revision, records a system history entry, and is
included in the single `run_finished` event. If metadata attachment becomes
impossible after GitHub created the PR, its link remains in the durable receipt
and conversation with the attachment error. No external result is silently lost.

Trusted completion instructions and execution-identity discovery remain in model
context only; the chat shows the Coordinator's separate result reply and the
existing thread card, while a person's own text is not hidden by an event prefix.

## Configuration

Configure the selected GitHub authority through a self-owned App, an explicit
Mikka Cloud connection, or a linked GitHub OAuth account with repository write
access. The legacy official App configuration uses Infisical-managed
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. Community App creation stores its
credentials encrypted in the database. See [App setup](github-app-manifest.md)
and [self-hosting](self-hosting.md#create-your-github-app). Live repository
access and PR publication require acceptance on that configured authority.

## Validation

- `pnpm test:run-publication`: GitHub transport, draft/no-verify, approval,
  identity, SHA, duplicate/ambiguous POST, and actual completion-route tests.
- `pnpm test:run-publication-db`: CI-only ephemeral PostgreSQL integration
  covering concurrent completions, leases, owner and device scope, branch
  collisions, revoked approval, retained PR receipts and retry convergence.
- `pnpm --filter @mikka/daemon exec vitest run test/adapters.test.ts test/runs.test.ts`:
  real local git, policy-only branch continuation and truthful unverified output.
- `pnpm typecheck`, `pnpm lint`, and migration/DB runner gates.

The original backend delivery ran no migration against a developer, Preview or
production database. Its R-66 frame and item-6 handoff are historical.
`RunSource.pullRequests` supplies owner-filtered output data. New UI evidence
follows [the design source order](design/README.md), and new GitHub publication
acceptance follows [the acceptance guide](acceptance.md).
