# Runtime acceptance

## Ordinary functional acceptance

Run ordinary functional acceptance in cloud Linux against a local application,
a real isolated PostgreSQL database and a real daemon when the flow uses one.
A deployed site and provider OAuth are not prerequisites for ordinary business
checks. Builds and type checks run in cloud Linux or CI; keep the existing rule
against starting those services or builds on the developer's Mac.

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
record the actual capability gap. The MVP CI's existing `register()` fixture is
one such automatic normal-registration path; it does not establish shared-pool
lease reuse or provider OAuth acceptance.

## Record the version and environment

Record the branch/revision, Git-linked CI run, application origin, database and
daemon environment, UTC interval, expected/actual behavior and observed request
IDs. Keep code and environment fixed during each run. Reuse completed checks
when their code and environment remain applicable, using Git's PR/commit-to-CI
association instead of repeatedly comparing identifiers. Recheck the affected
behavior when code/environment changes or the recorded version does not match.

Keep account credentials, cookies, tokens and retained browser state out of
logs, screenshots, reports and model-visible output. A real application/DB/daemon
run proves those paths; a scripted model or provider fixture does not prove a
real external provider worked. Record those distinctions without making an
unrelated real-model or OAuth run a prerequisite for a documentation change.

## OAuth-specific acceptance

For changes involving Google/GitHub OAuth rules, provider linking or OAuth
proxy/callback routing, verify the relevant real provider flow and exact return
origin. Reuse existing authorized provider/browser sessions. If the provider
requires MFA or reauthentication, hand over that specific provider step once;
never request passwords or verification codes in chat.

An existing authorized dedicated account is stored in Infisical project
`Mikka Test Account Vault`, environment `dev`, path `/test-account`, under
`MIKKA_TEST_ACCOUNT_EMAIL` and `MIKKA_TEST_ACCOUNT_PASSWORD`. Use this existing
source when the specific check needs that identity; it is not a routine account
retrieval requirement. Retrieve needed values only in memory and keep them out
of source, logs, screenshots and model-visible output. This project is separate
from cloud-computer execution credentials. Preserve provider verification checks.

For `account_not_linked`, diagnose the provider identity, existing account and
verification state without weakening ownership checks. Record the affected
provider as blocked and continue independent ordinary checks with their assigned
test identities. Passing GitHub does not establish Google acceptance.

Verify the intended identity and an actual Mikka session after OAuth. Exercise
sign-out on the origin being tested; unrelated origins must remain rejected.
Record the provider-specific result and remaining evidence separately from
ordinary functional acceptance.

## When the check specifically targets a deployed origin

A deployed-origin check records its unique deployment URL and associated code
version, so another publish cannot replace the reviewed application. A moving
branch alias, v0 `Latest` or the shared production domain is not a frozen target.
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
