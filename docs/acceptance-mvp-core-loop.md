# Mikka MVP core-loop acceptance (#181)

This record separates deterministic CI coverage from acceptance on a frozen
Preview. A green fixture run is not a record that a real GitHub App or model
worked in Preview. Production acceptance requires Alex's permission.

## Current execution status

The test implementation is committed; the integrated PR6 revision has not yet
completed the real browser CI gate. The steps below describe coverage and
expected behavior, not a successful acceptance run. Replace pending entries
only with evidence from the exact reviewed commit.

| Gate | Actual result | Evidence |
| --- | --- | --- |
| Integrated migration, source and browser CI | Pending on the integrated PR6 commit | Pending workflow URL, checkout SHA and job results |
| Real-daemon MVP browser loop | Pending; not yet accepted | Pending Playwright report, screenshots and `mvp-acceptance-evidence.json` |
| Frozen Preview | Blocked; not executed | Matching schema and authorized configuration delivery required; record below |
| Production | Not requested or executed | Requires Alex's prior permission |

## Deterministic CI gate

The `Browser tests (before merge)` job runs `pnpm test:e2e:mvp` after the
production build and performance gate, before the existing functional browser
suite. It uses the job's disposable
Postgres 17 service, with tracked migrations applied before the existing setup.
No test points at a developer, Preview or production database. The source-only
fixture checks run under `pnpm test:mvp-fixtures` and `pnpm check`.

The browser signs up through the existing email/password form using a generated,
disposable account. Its credential never enters a committed file or artifact.
The fixture provides an ephemeral daemon token, a synthetic linked GitHub subject
and an explicit repository push-approval receipt for that owner. These are setup
conditions; this test does not claim to accept GitHub OAuth or a future repository
approval UI. Daemon browser login is covered by its separate device-authorization
tests; this gate exercises the existing `daemon login --token` route.

### What actually runs

1. The real daemon CLI logs in with the test token, registers over HTTP and reports
   the built-in `mock` harness. Registration creates its hidden execution identity.
2. The browser opens the accepted new-task dialog, checks **Mikka Cloud** is the
   default, and deliberately selects the actual registered local device.
3. The form sends a real Coordinator message. The test checks the stored event's
   `taskDestination` and the host-supplied model context contain that exact device
   ID, so a scripted response cannot conceal a broken destination picker.
4. Mikka's existing AI SDK `WorkflowAgent` invokes real `create_issue`,
   `list_agents` and `dispatch_run` tools and their durable steps. No issue, run,
   conversation, output chunk or completion is seeded. The test checks that one
   task and one run were created on the selected device.
5. Claim sends fixture `mvp-core-loop`; a real daemon started with
   `--mock-speed 1 --fixtures-dir tests/mvp/fixtures` claims it, clones into its
   private cache, resolves `origin/HEAD` to **trunk**, and creates its own worktree.
   The test checks the worktree's `.git` points into that cache.
6. The browser reads progress and replies. The daemon consumes the real command,
   the recording acknowledges it, and the test checks the durable delivery receipt.
7. The recording writes `MIKKA_MOCK.md`. The daemon actually runs the repository's
   fixture verification command, `test -f MIKKA_MOCK.md`, commits and pushes.
8. The real server publication workflow verifies GitHub App installation and owner
   access through a stub, then requests a PR. The stub reads the **actual pushed
   commit** from the bare repo, checks the changed file and run/task commit footers,
   and only then returns PR #41. The server persists it on the task.
9. The actual completion event wakes the Coordinator. Its tools read the real run
   and task; the reply uses the PR receipt from that event. Playwright checks the
   result in chat and the PR chip on the R-66 card, without a progress line.
10. A second test stops an active real daemon run, checks the draft remains
    editable while stopping, waits for the terminal run state, and verifies no PR
    was opened. For the draft assertion only, it pauses browser polling and holds
    delivery of the real server-action response; the actual stop request and
    daemon proceed normally. It then releases the unchanged response and polling.

### Explicit substitutes and isolation

- **Model:** `tests/mvp/preload.mjs` supplies a scripted AI SDK default provider
  through a loopback Gateway-compatible service. The Coordinator engine, tool
  loop, workflow steps, authorization, DB and event delivery remain real.
  `MIKKA_NATIVE_COORDINATOR` stays unset. Provider-contract unit tests exercise
  the installed AI SDK against the same fixture protocol.
- **GitHub:** only requests to `https://api.github.com` are redirected by the
  test-only Node preload. The application has no configurable fake GitHub host.
  The fixture validates repository-scoped read/write token usage. Its App private
  key is generated in memory for this process and never persisted or printed.
- **Git:** the assignment uses the synthetic identity
  `https://github.com/mikka-e2e/core-loop.git` so production GitHub repository
  validation executes. Only the daemon child gets `GIT_CONFIG_COUNT` entries
  mapping that exact URL to a newly created `file://` bare repo. No user's global
  git configuration, `HOME`, credentials or checkout is changed. The explicit
  `MIKKA_TEST_MODE=1` gate is required to permit the file transport.
- **Fixture gate:** `MIKKA_MVP_E2E=1`, `MIKKA_TEST_MODE=1`, `CI=true` and
  `GITHUB_ACTIONS=true` must all be present. All three DB URLs must name the same
  loopback `/mikka_e2e` database. Vercel deployments, native Coordinator and remote
  browser targets are refused. Production harnesses never receive a fixture.

CI emits screenshots and `mvp-acceptance-evidence.json` as Playwright attachments.
They include the checkout SHA, UTC times, steps, device/run/task IDs, publication
workflow ID and fixture request IDs. Actual browser request IDs are included only
when the server returned them; the CI loopback server does not supply Vercel IDs.
Daemon credentials, `device.json`, `daemon.secret` and raw Workflow storage are
excluded. The whole database disappears with the job; daemon credentials are
revoked and temporary daemon/workflow/repository directories are removed.

## Frozen Preview acceptance — blocked, not executed

Do not fill this section from CI or infer successful acceptance. Pin the exact
commit and unique Preview deployment URL after all six PRs have passed CI.
The current delivery cannot complete this gate until its Preview database has
the matching tracked schema and the authorized Infisical delivery path can
supply the required configuration. Record the exact deployment and observed
access error in the PR delivery record before retrying; do not use a shared
database or production as a substitute.
Follow `docs/acceptance.md` for the authorized test account in Infisical's
**Mikka Test Account Vault**, environment `dev`, path `/test-account`:
`MIKKA_TEST_ACCOUNT_EMAIL` and `MIKKA_TEST_ACCOUNT_PASSWORD`. Keep values in memory
and out of logs/screenshots. Use direct Google/GitHub OAuth and reuse an authorized
session; do not inject a session row/cookie or weaken provider/account checks.
Use a test repository the account and installed GitHub App may access.

| Field | Value |
| --- | --- |
| Status | Blocked on matching Preview schema and authorized configuration delivery; no Preview acceptance claimed |
| Branch | Pending |
| Commit SHA | Pending; freeze before acceptance |
| Unique Preview URL | Pending |
| Deployment's commit verified | Pending |
| UTC start / finish | Pending |
| Test account reference | Infisical vault/path above; no values |
| Test repository / App installation | Pending; no installation token |
| Daemon package / version / OS | Pending |
| Device ID | Pending |
| Task ID / identifier | Pending |
| Run ID / publication workflow ID | Pending |
| Request IDs | Pending; copy observed IDs only |
| PR URL / state / pushed SHA | Pending |

| Step | Expected | Actual | Evidence |
| --- | --- | --- | --- |
| Existing login | OAuth returns to the exact frozen Preview under `/mikka` | Pending | Redacted screenshot + request ID |
| Connect computer | Approved install/login commands register an online device with Claude Code or Codex | Pending | Package version, device ID, screenshot |
| New task | Dialog defaults to Mikka Cloud; explicitly choose this local device | Pending | Screenshot with selected computer |
| Coordinator dispatch | One task and a thread on exactly that device; no user-facing Agent management | Pending | Task/run/device IDs, screenshot |
| Progress and reply | Progress appears; reply reaches the same thread | Pending | Screenshot, delivered message/run ID |
| Stop | Stop takes effect immediately; draft remains editable | Pending | Screenshot, request/run ID |
| Offline stop | Around 30 seconds without acknowledgement shows failure; retry works after reconnect | Pending | UTC timings, screenshots, request IDs |
| Result | Real verification result returns to Coordinator chat | Pending | Report and screenshot |
| Publish | Local git pushes task branch; installed GitHub App creates PR | Pending | Branch/commit, PR URL, request IDs |
| Thread card | PR chip has correct GitHub state color; no progress row; extra PRs fold to +N | Pending | Screenshot |

Record every failure with expected/actual behavior, UTC timestamp, task/run/request
IDs and a screenshot. Keep the Preview commit fixed while reproducing. If the
preview lacks a required App installation, permission or Infisical-delivered
configuration, report that specific missing prerequisite; do not use production
as a substitute.
