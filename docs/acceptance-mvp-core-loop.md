# Mikka MVP core-loop acceptance (#181)

> History. The current MVP acceptance is API and CLI only:
> [acceptance-mvp-cli-2026-11-01.md](acceptance-mvp-cli-2026-11-01.md)
> (`pnpm test:local-loop`); no browser tests run
> ([decision](design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md)).

Ordinary functional acceptance uses the real application, API, PostgreSQL and
local daemon in the registered isolated cloud Linux CI environment. It acquires
accounts automatically through the existing account pool. This PR does not
change OAuth rules, require a deployed site, or require a person to log in.
Provider-specific acceptance remains separate: a scripted model or GitHub API
fixture is never evidence that an external provider worked.

## Account allocation and login

`tests/mvp/accounts.ts` reuses `tests/e2e/test-account-fixtures.ts` and
`acquireTestAccounts`. The shared implementation proves the application/database
binding, acquires an exclusive owner/peer lease, registers a fresh account or
signs in an existing clean account through the normal Better Auth HTTP routes,
and verifies the returned identity and session. It does not insert a session or
mint an application cookie outside authentication.

The browser inherits the existing lease heartbeat, origin fence, session-file
protection and runtime-error assertions. Automatic screenshots, traces and video
are disabled; explicit screenshots mask inputs and avatars. Scenario evidence
records the environment, lease, generation and owner IDs, without credentials.

The two MVP scenarios retain business mutations, so their account pairs are
quarantined after both browser contexts close and the shared pool revokes their
issued sessions. They are not falsely returned as clean, reusable accounts.
The runner prepares four pairs: two for these retained scenarios and two clean
pairs for the following ordinary regression. Clean accounts retain the pool's
normal reuse behavior. No test user, fixture row or retained file is deleted.

The MVP server no longer sets a synthetic `AI_GATEWAY_API_KEY`. Its scripted
provider is installed by the existing test preload, and the existing
`runTestFixture` isolation check permits Coordinator wake-up only for the
explicit disposable CI fixture. Account-pool credential/environment validation
is unchanged. The account adapter remains limited to its registered isolated
CI/loopback environment; remote deployment support is not claimed.

## What the scenarios verify

1. The real daemon CLI authenticates with its tracked test token, registers over
   HTTP and reports its mock harness and protocol capabilities.
2. The real task dialog defaults to Mikka Cloud and accepts the selected local
   device. The stored host event fixes that device and is atomically bound to
   the issue produced by the actual Coordinator tool.
3. The real WorkflowAgent and durable tools create one issue and dispatch one
   run. No issue, run, conversation, output chunk or completion is seeded.
4. The daemon claims the assignment, clones into its own cache, resolves
   `origin/HEAD` to trunk and creates a real Git worktree.
5. A browser reply reaches the same thread and receives a durable delivery
   acknowledgement. Stop reaches the daemon and preserves the editable draft.
6. The completion scenario actually verifies, commits and pushes its file to
   the isolated bare repository. The GitHub fixture checks that pushed commit
   and task/run markers before returning the synthetic PR receipt.
7. The server publication workflow persists the receipt; the Coordinator returns
   it to chat and the thread card shows the PR link and state without internal
   progress text. Cancellation creates no PR.

Repository approval uses the real proposal store and authenticated browser
confirmation. Database tests independently exercise approval → inbox task
restoration → admission/replay, exact repository binding, revocation contention,
rejection of new prompts after revocation, continuation of accepted scope and
independent stop.

## Provider and environment boundaries

- The model is a scripted AI SDK provider with external requests refused by the
  preload. The real WorkflowAgent, tools, API and database execute normally.
- Runtime completion triage uses the real Decisions caller against an exact
  loopback fixture route. Its synthetic credential and visibly synthetic
  generation receipt exercise the request/response contract; they do not prove
  live model judgment. Unexpected models, questions or event kinds are refused.
- GitHub identity/API responses are synthetic. The daemon's transport rewrite
  maps only the fixture repository to an isolated bare Git repository. Real
  cloning, verification, committing and pushing execute without changing a
  person's checkout, HOME or global Git configuration.
- The explicit MVP/test/CI flags and matching loopback database targets are
  required. Deployed environments, remote targets, native Coordinator and
  production harness fixture assignment remain refused.
- The runner retains daemon, repository, workflow and account/session evidence.
  Device-token revocation and pool session invalidation are non-deleting.
- Production and existing Staging are not acceptance targets. Previously
  provisioned isolated resources remain preserved; no new sharing, account
  permissions or external-provider access is introduced here.

## Evidence and final revision

The prior head `29a5c6957d9687ab987595d1f2da9ec06a5288f5` passed
[CI](https://github.com/alexj11324/Mikka/actions/runs/40811073168) with all
24 mandatory database suites, and
[browser acceptance](https://github.com/alexj11324/Mikka/actions/runs/40811080804)
with 113 functional cases, 2 daemon scenarios and 14/40 subset cases. Its actual
browser checkout `d5f9069822d602339d95c6aacc55359d78394246` had the same source tree.
Those results predate the MVP account-pool integration and do not accept its
new revision. The final exact-head workflow, account-lease attachments,
`mvp-acceptance-evidence.json` and evidence scan must pass before merge.

Performance follows the repository's integration policy. Authentication and
provider claims must match their actual test scope; ordinary account-pool login
is not OAuth-provider validation. Record the final head and actual CI checkout
in [PR #362](https://github.com/alexj11324/Mikka/pull/362).
