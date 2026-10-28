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
a new thread and explicitly approve the current repository identity. Only old
GitHub physical-checkout records with a verified equivalent endpoint can reuse
their record ID, without changing the clone URL. No data migration grants a push.

`repository_settings.push` stores `{ approved, remote: 'origin',
approvedByUserId, approvedAt }`, keyed by `(userId, remoteKey)`. Only the
human-session backend action can create that receipt; neither MCP nor native
Coordinator tools expose it. A bare boolean is insufficient. The proposed chat
approval entry point remains **待 Alex 确认** in `design/decisions.md`.

Claim sends `pushBranch` and `policy.permissions.git_push`. `/repos` does not
cache push approval. The daemon uses the same policy for fetching the previous
task branch and pushing the next commit, with local git credentials and no
force push. Settings revocation blocks subsequent claims and server PR creation.

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
This missing-verification behavior is a proposed product decision, **待 Alex 确认**.

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
