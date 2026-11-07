# Runtime acceptance

## Ordinary functional acceptance

Run ordinary functional acceptance locally, in the session's cloud Linux
container, against `pnpm dev`, a real isolated PostgreSQL database and a real
daemon from source when the flow uses one ([dev workflow](dev-workflow.md)).
Do not wait for CI, a merge or a deploy to check what can be checked here. A
deployed site and provider OAuth are not prerequisites for ordinary business
checks. Keep the existing rule against starting those services or builds on
the developer's Mac.

Use the existing automatic test-account allocation, reuse and lease mechanism
by default: `acquireTestAccounts` in `scripts/test-accounts/session.mjs` uses
`pool.mjs` and returns separate owner/peer identities and browser storage state.
It obtains a real application session through `/api/auth/sign-up/email` or
`/api/auth/sign-in/email` and verifies `/api/auth/get-session`. Routine tests do
not require the user to sign in manually, supply a password or complete OAuth.
Use the helper's lease renewal/release and existing evidence auditing; retain
resources and logs as required by the current task.

The shared adapter currently implements `isolated-ci` and loopback application
and database targets. Its environment descriptor binds the application version,
origin and actual database identity. These checks remain in force. This is an
implementation boundary, not a user policy prohibiting deployed or other test
environments. Where that adapter is not implemented, use an existing supported
automatic test-identity fixture or authorized session for that environment and
record the actual capability gap. Acceptance runs through the API and the CLI
(`pnpm test:local-loop`); no browser tests run, locally or in CI
([decision](design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md)).

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
sessions above. Live model-path acceptance (API key, Claude Code subscription,
Codex subscription) runs through the normal Owner UI of the existing Owner
account, which already has those sources bound. Preserve provider verification
checks.

For `account_not_linked`, diagnose the provider identity, existing account and
verification state without weakening ownership checks. Record the affected
provider as blocked and continue independent ordinary checks with their assigned
test identities. Passing GitHub does not establish Google acceptance.

Verify the intended identity and an actual Mikka session after OAuth. Exercise
sign-out on the origin being tested; unrelated origins must remain rejected.
Record the provider-specific result and remaining evidence separately from
ordinary functional acceptance.

## Shared production acceptance workspace

验收工作区：**Acme Inc.**。**验收在这个工作区里做**。

Use the existing shared smoke test account for subsequent production acceptance
in this workspace. Alex's account was authorized only for the one-time invitation
and subscription-sharing setup in
[issue #1515](https://github.com/alexj11324/Mikka/issues/1515#issuecomment-6694934529).
Ordinary acceptance must not sign in as Alex. For production checks described
below, use this shared-account team scope rather than an isolated account-pool
lease. Keep the normal identity, membership and cleanup checks.

The one-time setup and the subsequent fixed-deployment production verification
are recorded in [issue #1415 acceptance report](acceptance/issue-1415/final-report.md).
The setup made the existing Claude and Codex subscription sources visible; it
created no API key and is not a model-prompt result.

## Production acceptance after a merge

Local acceptance comes first; it does not replace production acceptance. After
the owning agent merges its PR ([dev workflow](dev-workflow.md) § 5):

1. Watch the Vercel production deployment of the merge commit until it is
   READY, and confirm the production domain serves that commit.
2. Pending migrations run through the existing flow (`pnpm build` runs
   `scripts/migrate.mjs` in Vercel production; [migration bootstrap](migration-bootstrap.md)).
   Do not apply SQL by hand.
3. Check each acceptance criterion of the issue in production, with a real
   account and a real task. Use leased test accounts ([test accounts](test-accounts.md));
   leave no junk data. A simulated or scripted test is not production
   acceptance.
4. Write the evidence on the issue: time, run id and a log summary, with no
   secrets or personal data. Then close the issue.

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
