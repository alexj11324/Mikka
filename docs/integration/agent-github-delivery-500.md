# Agent-owned GitHub delivery (#500)

Coding agents own commit, push, PR creation and CI repair. A live coding
Agent can still use native `gh pr checks --watch` in its run to read and
repair failing checks. A verified GitHub `check_suite.completed` event can
now wake the already bound bot's Coordinator after the original run ended,
without keeping a sandbox alive to poll. **This does not automatically resume
the ended native CLI session** or certify that all required checks passed.

## Credentials

The server selects the run owner's authorized GitHub credential through
`githubMachineCredential`. A self-owned GitHub App takes precedence. A linked
self-hosted cloud GitHub capability supplies a native installation token scoped
to the run repository. The ordinary owner path uses the linked GitHub App user
token or legacy GitHub sign-in connection. See
[GitHub cloud setup](../self-hosting-github-cloud.md).

`POST /api/runs/github-token` accepts the existing worker bearer token and
derives the run owner and repository on the server. It checks the live run,
lease, STOP state and enabled owned device, then rechecks the same scope after
credential retrieval. Responses are `no-store`. This compatibility exchange
caps its answer at one hour. The device credential-lease path used during
native preparation and renewal retains the provider's natural expiry.

Cloud execution prepares native Git and gh credentials once in the task VM's
ordinary HOME. `prepareMachineGitHub` writes the normal gh credential file
with mode 0600 and uses the real gh binary for Git authentication. Expiring
auth renews in the background. Git and gh operations use the prepared native
credential directly. One task owns the VM, including retained state while
paused. The selected CLI and GitHub credential delivery follows the
[machine execution decision](../design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md).

On a local device, `prepareLocalGitHub` uses a private run-owned gh configuration
outside the checkout and retains the person's existing native login. Its gh
watch helper restarts long watches so the real CLI rereads the renewed file.
Local cleanup removes its own configuration. Cloud cleanup preserves later
manual edits and can retain the task credential until VM reclamation.

Third-party user, workspace and repository Secrets follow the separate
[credential exposure decision](../design/decisions/2026-11-08-0240-credential-exposure-boundary.md).
The current [task-secret projection](../../lib/secrets/runtime.ts) separates
protected Secrets from ordinary env and explicitly direct-exposed values.
Runtime acceptance remains version-bound under [the acceptance guide](../acceptance.md).
Credentials stay out of arguments, logs, chat, reports and reusable templates.

## Completion

The task PR body ends with its `mikka-issue` marker. Completion verifies the
already-committed tree, pushed task branch, PR binding and the exact commit's CI
rollup. The daemon does not create another commit or push after the CI result.
Read-only receipt work uses daemon-private configuration, not executable files
or configuration from the agent-writable run directory. Normal local sandbox
and hosted native execution retain their existing filesystem, network, lease
and subscription boundaries.

## GitHub CI completion wakeup (#2064)

The existing signature-verified GitHub App webhook accepts completed
`check_suite` events only. Per-job `check_run` and `workflow_run` do not
generate additional Agent wakeups; the existing per-check and commit-status
UI projections remain independent. A suite identifies only a current published
PR head for a source-bound repository and an already finished Agent run.
Unknown, stale, closed, cross-repository, unbound and unsigned inputs never
create a Coordinator message. Suites lacking PR numbers (for example, fork
checkouts) are matched by their exact head SHA and repository within already
published PRs, never by a broad GitHub search.

A successful match creates a `run_report` in the existing deduplicated
Coordinator outbox, bound to the run's user, bot and task. The webhook does
not trust its reported success as the final status: the next Agent decision
must fetch current GitHub checks, required check names, head SHA, reviews and
merge policy under the normal owner credentials. Neither success nor failure
is direct authorization to merge, publish or increase an Agent's grants.
The outbox entry is persisted before acknowledging the inbound webhook, so
a delivery failure can be retried without duplicate downstream turns.

**Subscription requirement:** the GitHub App must subscribe to
`check_suite` and `status`; new self-hosted manifests include these.
The existing hosted App is *not* reconfigured by the source-code change.
Until its real subscriptions, deployment, and signed delivery are verified,
this is implementation evidence, **not** production proof.

## Evidence boundaries

Focused automated tests cover the actual authorization logic with explicit
DB/identity IO substitutes, STOP races, credential cache renewal, native watch
restarts, real isolated Git repositories, and receipt validation. A test GitHub
response or CLI fixture does not prove a live user token's reach, a real PR's
CI failure/repair, or a native model run.
Record those live results separately before closing #500; existing machine gh
authentication is not a substitute for the worker-token exchange.

## Earlier verification

The implementation this document first described (one repository's
installation token per run) was verified on 2026-11-01; those results do not
cover the owner-credential exchange above.

The real database runner is `scripts/acceptance/run-github-token-500.mts`.
It requires matching `E2E_DATABASE_URL`, `MIKKA_DATABASE_URL`, `DATABASE_URL`
pointing at an isolated loopback `_e2e` database and runs with:

```sh
REQUIRE_DB=1 NODE_ENV=test node --import ./tests/support/server-only.mjs \
  --import tsx --test scripts/acceptance/run-github-token-500.mts
```
