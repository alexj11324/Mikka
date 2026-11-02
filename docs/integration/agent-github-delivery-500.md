# Agent-owned GitHub delivery (#500)

Coding agents own commit, push, PR creation and CI repair. CI webhooks do not
resume an ended agent. The agent stays in its existing run, waits with
`gh pr checks --watch`, reads failures and repeats until its final commit passes.

## Credentials

Every run gets its owner's own GitHub credential
([decision](../design/decisions/2026-11-02-1600-agents-use-own-github-credential.md)),
the same as `gh auth login` in the person's own terminal: the GitHub App user
token of their Plugins › GitHub connection, or their GitHub sign-in account
linked before connections existed. It reaches every repository they
authorized and can clone, commit, push, open pull requests and comment.

`POST /api/runs/github-token` accepts the existing worker bearer token. The
request names nothing. The server checks the run token, that the run is live
(preparing or running, not stopped, lease unexpired) and that the run and its
enabled device belong to the token's person, then returns that person's token
and an expiry at most an hour away. Any run kind gets it, read-only and plan
runs included. Authorization is checked again after the token is read; if it
changed, nothing is returned. The token is the person's own, so it is not
revoked when a run ends; the run token stops working instead. Errors are codes
only (`githubNotConnected`, `githubReconnectRequired`, `runGitHubUnavailable`,
`runGitHubAccessDenied`). Responses are `no-store`.

Git and gh use run-local private files outside the checkout. The git helper
answers for any `https://github.com` repository and no other host; gh gets no
fixed repository. Tokens are cached for at most fifty minutes, 0600. Each long
native gh watch process is restarted after forty minutes with a token having
at least forty-one minutes left; the server refreshes a connection token that
expires within forty-five minutes, one refresh at a time per person. No global
git/gh login or developer credential is copied, and the token never reaches
argv, an environment dump, chat or a log.

## Completion

The task PR body ends with its `mikka-issue` marker. Completion verifies the
already-committed tree, pushed task branch, PR binding and the exact commit's CI
rollup. The daemon does not create another commit or push after the CI result.
Read-only receipt work uses daemon-private configuration, not executable files
or configuration from the agent-writable run directory. Normal local sandbox
and hosted native execution retain their existing filesystem, network, lease
and subscription boundaries.

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
