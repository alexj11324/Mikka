# Runtime acceptance

Use this guide to verify an issue through the affected runtime and record
version-bound evidence. `AGENTS.md` and accepted decisions govern account,
model and release authorization.

## Ordinary functional acceptance

Run ordinary functional acceptance locally, in the session's cloud Linux
container, against `pnpm dev`, a real isolated PostgreSQL database and a real
daemon from source when the flow uses one ([dev workflow](dev-workflow.md)).
Do not wait for CI, a merge or a deploy to check what can be checked here. A
deployed site and provider OAuth are not prerequisites for ordinary business
checks. Keep the existing rule against starting those services or builds on
the developer's Mac.

Use the existing shared SMOKE account in **Acme Inc.** for acceptance against
the shared application, following [the workspace contract](#shared-production-acceptance-workspace).
Do not sign in as Alex. Isolated regression harnesses that bootstrap their own
disposable database use `acquireTestAccounts` in
`scripts/test-accounts/session.mjs` and `pool.mjs`. Those harnesses provision
owner/peer fixtures through normal email sign-up/sign-in and verify the real
session. Follow their lease renewal, release and evidence auditing. Their
results establish the isolated fixture path, while shared-team subscriptions
require the shared-account check.

The shared adapter implements `isolated-ci` for loopback application targets
and `isolated-docker` for the separately bound Docker environment. Both keep
the database on a loopback `*_e2e` target. Its environment descriptor binds the
application version, origin and actual database identity. These checks remain
in force. This is an implementation boundary, not a user policy prohibiting deployed or other test
environments. Where that adapter is not implemented, use an existing supported
automatic test-identity fixture or authorized session for that environment and
record the actual capability gap. Ordinary acceptance runs through the API
and CLI (`pnpm test:local-loop`) under the
[accepted policy](design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md).
The general browser suite is retired. Retained targeted Desktop, Analytics and
self-hosted checks keep the source-bound scopes in the
[workflow reference](../.github/workflows/README.md).

## Record the version and environment

Record the branch/revision, the local run (and the Git-linked CI run once it
reports), application origin, database and daemon environment, UTC interval, expected/actual behavior and observed request
IDs. Keep code and environment fixed during each run. Reuse completed checks
when their code and environment remain applicable, using Git's PR/commit-to-CI
association instead of repeatedly comparing identifiers. Recheck the affected
behavior when code/environment changes or the recorded version does not match.

Keep account credentials, cookies, tokens and retained browser state out of
logs, screenshots, reports and model-visible output. A real application/DB/daemon
run proves those paths; a scripted model or provider fixture does not prove a
real external provider worked. Record those distinctions without making an
unrelated real-model or OAuth run a prerequisite for a documentation change.

## Historical Factory candidates awaiting checks

For a flow v1 candidate whose verification is waiting, blocked or failed, or
whose approval is still pending, the Owner can open the existing acceptance
pane and choose **Retry review**. The host exposes this action only for the
same unaccepted candidate and request, with no active execution or lease. A
current unanswered question is superseded atomically. If that exact waiting
question has expired, it stays expired (or its elapsed deadline is recorded as
expired in the same Owner transaction); its expiry, answer and continuation
are never renewed. The new Owner receipt distinguishes expiry from supersession.
An answered question or failed strict continuation must use its existing
recovery path. A deadline that crosses the preflight/write boundary refuses as
stale, so the Owner must review the current state again.

This action appends an independent review and then an independent verification,
each on its own original frozen native subscription, model and read-only
policy. Historical reports and receipts remain unchanged, including incomplete
or failed results. A failed new check stays failed until a separate repair is
requested. Missing source authority, changed Profiles, unavailable official
quota or a stale revision cannot select another model or consume the question.
The Owner receipt also pins provider recovery during the new checks: a rate
limit or exhausted subscription blocks this round instead of adopting another
subscription or API key from the current preference order.
Flow v2 retains its one-review contract and has no such action.

Local acceptance covers both entry states through the normal Owner API, real
PostgreSQL transactions, independent queued runs, exact-source dispatch and
event replay. UI review captures both states from a local production build;
browser screenshots do not establish that an external model ran or that an
independent check passed.

A lost response replays the committed Owner receipt without creating or starting
another run. A post-commit cloud startup failure remains a real blocked run;
it is not a Profile refusal. The existing Owner retry API can create a pending
attempt, and the normal host dispatcher retains the round's frozen source.
This action does not add a separate startup-recovery UI or guarantee that every
historical pending attempt is picked up automatically.

## OAuth-specific acceptance

For changes involving Google/GitHub OAuth rules, provider linking or OAuth
proxy/callback routing, verify the relevant real provider flow and exact return
origin. Reuse existing authorized provider/browser sessions. If the provider
requires MFA or reauthentication, hand over that specific provider step once;
never request passwords or verification codes in chat.

There is no separate Infisical vault for an OAuth test account; the Aspectly Labs
organization has no such project. Use the existing authorized provider/browser
sessions above. Live model-path acceptance uses the shared test account and the
subscription paths described in [Live model acceptance](#live-model-acceptance).
Preserve provider verification checks.

For `account_not_linked`, diagnose the provider identity, existing account and
verification state without weakening ownership checks. Record the affected
provider as blocked and continue independent ordinary checks with their assigned
test identities. Passing GitHub does not establish Google acceptance.

Verify the intended identity and an actual Mikka session after OAuth. Exercise
sign-out on the origin being tested; unrelated origins must remain rejected.
Record the provider-specific result and remaining evidence separately from
ordinary functional acceptance.

## Live model acceptance

For a change that runs model work, cover the official Claude Code subscription
with `claude-haiku-5-5` and the official Codex subscription with `gpt-6-luna`.
Keep each existing case on its originally bound subscription. Record a blocked
path's real quota, rate-limit or provider error and continue the independent
path. Both passing paths complete the model coverage. One passing path does
not prove the other.

The DeepSeek/API-key leg never gates a merge or acceptance. Do not send paid
API-key prompts to retry a blocked leg or substitute Pro, another provider or
another model. The existing `test:local-loop` driver still requires a real
DeepSeek key and asserts Flash selection, so its local-flow results do not
establish either subscription path. Record that implementation gap without
making it an additional gate. The built-in Decision judge is separate from
these user-selectable coding models and keeps its configured model.

## Personal Workspace acceptance

Use `scripts/acceptance/personal-workflow.mjs` to select an account's own personal
Workspace explicitly. The existing shared acceptance drivers keep their team
default. A personal request never falls back to a team or borrows its subscription.
Use the existing `SMOKE_OWNER_EMAIL` / `SMOKE_OWNER_PASSWORD` binding for an
authorized ordinary test account; do not copy the execution host's CLI identity.
The existing account-pool runner can also supply its own generated credentials
in process for an attested loopback environment. That path requires the private
bound descriptor, matching compiled deployment SHA and database attestation; it does
not admit ordinary account credentials on a production origin.

The package command supplies the required `tsx` loader for the protocol TypeScript imports.
Start with metadata readiness against the isolated local application:

```sh
corepack pnpm acceptance:personal \
  --origin http://127.0.0.1:3000 --workspace PERSONAL_WORKSPACE_UUID
```

This selects the exact authorized `personal` choice, verifies the account's active
admin membership, reads back the ordinary Workspace cookie and session, and
restores the original selection before signing out. It reads subscription/model
and local device/Agent metadata. It creates no Bot, profile, task, machine or
provider lease. `ready_for_attempt` always carries `executionVerified: false`.
The report contains closed status/error codes rather than account labels,
credentials, device names or Agent instructions.

An execution attempt requires an existing enabled, online local device, its
matching Agent, source pins and one explicit harness:

```sh
corepack pnpm acceptance:personal \
  --origin http://127.0.0.1:3000 --workspace PERSONAL_WORKSPACE_UUID \
  --operation execute --harness codex --device-id DEVICE_UUID --agent-id CODEX_AGENT_UUID \
  --expected-build APPLICATION_SHA --revision DRIVER_SHA
```

Run the independent Claude case with `--harness claude_code` and its originally
bound Agent/subscription. Each command runs one case: Codex uses `gpt-6-luna` and
Claude Code uses `claude-haiku-5-5`. A successful case does not cover the other
subscription. There is no automatic model/provider fallback or retry. Personal
execution cannot choose an implicit cloud machine. The device must advertise a
successful native subscription preflight with the exact versions in
`packages/daemon/harness/pins.json`; metadata readiness still cannot prove that
the server can acquire a real provider lease or that a model call succeeded.
The existing execution and native receipt checks establish that evidence.

Add `--probe files --expected-worker-sha WORKER_SHA
--expected-worker-source WORKER_SOURCE_SHA` to reuse the Files acceptance driver.
Personal fixtures use the normal personal task action, without a Team. Its
immutable installed-worker marker and native shell/file receipts remain required;
a source daemon without that release installation cannot pass them. A single
successful Files case reports `partial` and the required/verified harness lists.
Both original subscriptions remain necessary for complete coverage.

Readiness reports `startup_personal_runtime_unavailable` when the normal
subscription endpoint cannot expose its configured backend,
`startup_personal_subscription_missing` when the account has no matching source,
`startup_personal_model_missing_or_ambiguous` for an absent or foreign fixed-model
candidate, and separate device/native-runtime/Agent errors for a missing,
disabled, offline or incompatible target. Record blocked cases as blocked;
fixture metadata and empty harness lists do not prove native model execution.

## Shared production acceptance workspace

验收工作区：**Acme Inc.**。**验收在这个工作区里做**。

Use the existing shared smoke test account for subsequent production acceptance
in this workspace. Its credentials are the Mikka Infisical project's `prod:/`
`SMOKE_OWNER_EMAIL` and `SMOKE_OWNER_PASSWORD`. Sign in directly through the
existing authorized cloud configuration and keep the values out of output.
Alex's account was authorized only for the one-time invitation and
subscription-sharing setup in
[issue #1515](https://github.com/alexj11324/Mikka/issues/1515#issuecomment-6694934529).
Ordinary acceptance must not sign in as Alex. For production checks described
below, use this shared-account team scope rather than an isolated account-pool
lease. Keep the normal identity, membership and cleanup checks.

The one-time setup and the subsequent fixed-deployment production verification
are recorded in [issue #1415 acceptance report](acceptance/issue-1415/final-report.md).
The setup made the existing Claude and Codex subscription sources visible; it
created no API key and is not a model-prompt result.

## Production acceptance after a merge

After the owning agent merges its PR ([dev workflow](dev-workflow.md) § 5):

1. Watch the Vercel production deployment of the merge commit until it is
   READY, and confirm the production domain serves that commit.
2. Pending migrations run through the existing flow. `pnpm build` runs
   `scripts/migrate.mjs` in the production-mode GitHub Actions build before
   deploying the prebuilt output to Vercel. See
   [migration bootstrap](migration-bootstrap.md). Do not apply SQL by hand.
3. Decide whether the change needs production acceptance (Alex, 2026-11-07):
   - **No**, when a local production build can show it: UI, interaction,
     navigation, page refresh, layout and copy. CI plus the PR's screenshots
     of a local production build accept it. Note on the issue that production
     serves the merge commit, and close it. Do not sign in to production,
     wait for a merge window or hold `main` for these.
   - **Yes**, only for what cannot be tested locally: real subscriptions
     (Claude Code, Codex), OAuth sign-in, model providers, the GitHub App,
     payments, push notifications and other external services. Check those
     criteria in production with the shared test account in the Acme Inc.
     workspace (above) and a real task; leave no junk data. A simulated or
     scripted test is not production acceptance.
4. Write the evidence on the issue: time, run id and a log summary, with no
   secrets or personal data. Then close the issue.

The [2026-11-07 production acceptance decision](design/decisions/2026-11-07-1400-production-acceptance-scope.md)
calls for automatic sign-in, a Coordinator message and task dispatch after each
Web deploy. The implemented `production-smoke.yml` job runs
`scripts/ops/production-smoke.mjs`, which signs in and reads the shell,
capabilities and shared-team Coordinator runtime. `AGENTS.md` records that
implementation and keeps messaging and dispatch in separate live acceptance
until the automatic-smoke gap is implemented. The workflow writes its result
and artifact on every run. Inspect a failure and fix the responsible path
through the normal release flow. See [production smoke](production-smoke.md)
for the exact coverage.

If production breaks, fix forward with a new PR or revert through a revert
PR. Never delete deployments, revoke shared tokens, change production Neon
settings or create paid resources without Alex.

## When the check specifically targets a deployed origin

A deployed-origin check records its unique deployment URL and associated code
version, so another publish cannot replace the reviewed application. A moving
branch alias, v0 `Latest` or the shared production domain is not a frozen target;
for production acceptance, first confirm the domain serves the merged commit.
Deployment is not a general prerequisite for local functional acceptance.

For a GitHub-backed v0 project, its working-branch deployment can be reviewed
without publishing to production. The embedded sandbox and a Vercel deployment
are distinct runtimes; verify the actual origin and session relevant to the
check. For OAuth proxy acceptance, prove the round trip from the originating
runtime through `https://app.aspectlylabs.com` and back to that same origin.
The callback hub must not switch the reviewed application to production or
another Agent's deployment.

References: [v0 branches and previews](https://v0.app/docs/github),
[v0 deployment behavior](https://v0.app/docs/deployments),
[Better Auth OAuth proxy](https://better-auth.com/docs/plugins/oauth-proxy).
