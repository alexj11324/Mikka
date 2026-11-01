# Run result publication

This delivery connects an approved local git push to an issue PR and the
Coordinator's existing conversation. Cloud queue/runtime are unchanged.

## Assignment and approval

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

Push authority is what the person granted on GitHub
([decision](design/decisions/2026-11-01-1215-push-by-github-app.md)): the Mikka
GitHub App's installation on the repository grants `contents: write`, and the
person's own linked GitHub account may write to it (the App is shared by every
Mikka user, so their own access keeps one person from pushing to another's
repository). Mikka asks for no approval of its own and shows no push card.

Dispatch checks GitHub live before the admission transaction
(`lib/github/push-grant.ts`) and records the outcome on
`github_repository_installations.pushGrantedAt` (cleared when GitHub refuses).
Admission reads that record under a share lock; a host dispatch already inside
its own transaction (Factory) relies on a check from the last 24 hours, and so
does a dispatch while GitHub cannot be reached. A workspace policy or read-only
mode that denies `git_push` still denies; `ask` no longer asks. New admission
receipts carry `authority: 'github_app'` and the check's time as `approvedAt`.
Receipts from the earlier per-repository approval (`repository_approval`) still
match; old `configured_allow` receipts without `approvedAt` grant nothing.
`repository_settings.push` and its pending cards remain readable history but
grant and withhold nothing.

When GitHub refuses, dispatch returns `runInvalid` with a `reason`
(`githubAppNotInstalled`, `githubAppPermissionRequired`, `githubAppSuspended`,
`githubIdentityRequired`, `githubAccessDenied`, `repositoryNotGithub`, …) and a
sentence with the GitHub installation link (`lib/run-invalid-reason.ts`); the
Coordinator sends the person to GitHub. Plugins › GitHub shows 推送分支 as
「由 GitHub App 授权决定」, with no switch; 创建 Pull Request keeps allow / ask /
deny.

Claim sends `pushBranch` and `policy.permissions.git_push`; it sends `allow`
only for an admitted receipt, and a claim without a publication never forwards
a configured `allow`. `/repos` does not cache push authority. The daemon uses
the same policy for fetching the previous task branch and pushing the next
commit, with no force push. The run's GitHub token and the pull request check
the App installation and the person's access on GitHub live.

A cloud (E2B) run follows the same rule. Cloud dispatch checks GitHub live, and
queueing gives the run a `github_app` receipt and an approved publication when
the grant is recorded; claim prepares that publication before the lease and
sends `allow`, with the run-scoped GitHub delivery. A cloud run without the
grant still runs, with `git_push: deny`. No run, local or cloud, is ever sent
`ask` for a push.

A read-only run (`dispatch_run` with `readOnly: true`: an investigation or
review that changes nothing) needs none of this, because it never pushes. Its
frozen definition carries `readOnly`; it gets no admission receipt, no
publication or push branch, and claim sends the read-only policy (`git_push`,
writes and scripts denied), whatever the CLI policy says. It ends `succeeded`
with its report and publishes nothing.

A read-only run (`dispatch_run` with `readOnly: true`: an investigation or
review that changes nothing) is admitted without the repository approval,
because it never pushes. Its frozen definition carries `readOnly`; it gets no
admission receipt, no publication or push branch, and claim sends the
read-only policy (`git_push`, writes and scripts denied), whatever the CLI
policy says. It ends `succeeded` with its report and publishes nothing. A run
that may commit still needs both gates; when admission refuses it, the error is
`runInvalid` with a `reason` (for example `repositoryPushApprovalRequired`)
and a sentence the Coordinator acts on (`lib/run-invalid-reason.ts`).

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
and may commit/push only after repository approval. Without an approved,
matching, actually pushed result the thread stays stopped/unverified and the
task is not advanced to review. After a successful approved push the server
requests a draft PR and tells the Coordinator that human checking remains.
A failed verify never publishes. A harness's self-reported verification is
discarded in both the approved and unapproved paths.
Alex approved this missing-verification behavior on 2026-10-28.

The GitHub client reuses an existing task-marked PR. An unverified continuation
converts that task's open PR to a draft before recording its result. It never
automatically reopens a closed PR or marks a draft ready for review.

## GitHub ownership and permissions

The server resolves the installation for the repository, checks it is active and
has `pull_requests: write` and `contents: read`, and uses a read-only repository
token to resolve the user's stable GitHub account ID and check write/admin access.
Only then does it mint a PR-write token restricted to the target repository ID.
Tokens and private keys never enter rows, workflow arguments, logs or responses.
`github_repository_installations` stores only verified non-secret IDs.

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

Existing Infisical-managed variables: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`.
The App must be installed on each target repository with `pull_requests: write`,
`contents: read` and standard metadata access. No live installation or permission
was verified during implementation. A linked Better Auth GitHub account with
write access is required; a Google-only account needs that connection first.
There is no new login method or approval UI in this backend delivery.

## Validation

- `pnpm test:run-publication`: GitHub transport, draft/no-verify, approval,
  identity, SHA, duplicate/ambiguous POST, and actual completion-route tests.
- `pnpm test:run-publication-db`: CI-only ephemeral PostgreSQL integration
  covering concurrent completions, leases, owner and device scope, branch
  collisions, revoked approval, retained PR receipts and retry convergence.
- `pnpm --filter @mikka/daemon exec vitest run test/adapters.test.ts test/runs.test.ts`:
  real local git, policy-only branch continuation and truthful unverified output.
- `pnpm typecheck`, `pnpm lint`, and migration/DB runner gates.

No migration was executed against a developer, Preview or production database.
The R-66 card follows the review frame linked in `design/decisions.md`, which is
still **待 Alex 确认**. `RunSource.pullRequests` supplies owner-filtered output data.
Real fixed-Preview screenshots and acceptance remain part of item 6.
