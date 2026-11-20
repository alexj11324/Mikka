# Runtime acceptance

Use this guide to verify an issue through the affected runtime and record
version-bound evidence. `AGENTS.md` and accepted decisions govern account,
model and release authorization.

## Ordinary functional acceptance

Use the [runner/checker process](../.agents/acceptance/PROCESS.md) for the scope
plan, executable plan, execution, and independent final verdict. The
[project adapter](../.agents/acceptance/PROJECT.md) identifies local commands,
scripted model/provider boundaries, fixture screenshots, probes, and the
distinct device/E2B evidence. Run ordinary behavior through the API/CLI in
isolated cloud Linux; UI captures use a local production build of the official
public/private pair.

Isolated harnesses acquire owner/peer accounts through
`scripts/test-accounts/session.mjs` and `pool.mjs`, as
[test accounts](test-accounts.md) describes. The supported adapters keep the
database on loopback `*_e2e`, bind the actual application/database identity,
and preserve lease ownership and cleanup. A pool result establishes that
isolated fixture path. For shared production, use the
[shared workspace contract](#shared-production-acceptance-workspace) instead.

## Record the version and environment

The [process](../.agents/acceptance/PROCESS.md#3-execute-and-collect-evidence)
owns source/environment binding, sanitized artifacts, evidence reuse, and
`pass` / `fail` / `uncertain` decisions. A fake response proves the exercised
contract, not a live external service. A production-only limitation needs its
owner and internal account alias in the PR's Acceptance declaration.

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
sessions above. Use the authorized internal account for the external OAuth check. Model
acceptance remains scripted under the policy below.
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

This anchor is retained for existing links. The former live-subscription test
instructions are superseded by Alex's
[scripted model acceptance decision](design/decisions/2026-11-20-1855-scripted-model-acceptance.md)
and [#2891](https://github.com/alexj11324/Mikka/issues/2891).

Development, CI, local-loop, and nightly acceptance use scripted or recorded
responses at the LiteLLM HTTP boundary. Keep admission, authorization, tool
execution, the daemon, and the isolated database real. Cover both applicable
native protocols with their recorded or scripted provenance; do not call a
live provider or supply a model key. Fixture evidence does not establish live
subscription compatibility, model quality, or deployed model mappings.

## Personal Workspace acceptance

Follow the accepted [personal-workflow-first decision](https://github.com/alexj11324/Mikka/blob/74ca8e84cd323c24c479bf64937d696d53d32ffb/docs/design/decisions/2026-11-11-1400-personal-workflow-before-channels.md)
in [#1875](https://github.com/alexj11324/Mikka/pull/1875), with the existing
[glossary](design/glossary.md) for product terms.

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
It requires the existing `apiKeyAfterQuota` policy to be explicitly false and
rechecks it before task creation; the driver preserves the setting. Enabled or
unavailable policy metadata blocks the subscription attempt.
The report contains closed status/error codes rather than account labels,
credentials, device names or Agent instructions.

Model-backed execution acceptance follows the scripted LiteLLM and native
protocol cases in the [project adapter](../.agents/acceptance/PROJECT.md).
The earlier `--operation execute` subscription commands are not part of the
acceptance workflow. Metadata readiness remains a read-only capability check;
it does not prove dispatch, files, or a model result. Record the real daemon,
run, and persisted effect for every execution claim.

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

### Historical owned-account cases

Issue #1918's one-time owned-account authorization and subscription evidence
remain historical provenance in the
[owned Codex Cloud decision](design/decisions/2026-11-11-1405-owned-codex-cloud-mcp-acceptance.md)
and [issue #1415 report](acceptance/issue-1415/final-report.md).
They do not authorize this workflow to send real model prompts or substitute
that account for the shared internal acceptance identity.

## Production acceptance after a merge

After merging, verify the exact merge SHA and follow the existing
[release process](dev-workflow.md#5-ownership-and-merging) and
[build source of truth](operations/build-source-of-truth.md). GitHub Actions
builds the trusted artifacts; the release owner controls Cloudflare staging,
promotion, and migration windows. A PR, build, or deployment start is not a
serving-version receipt.

Local production-build screenshots cover UI, interactions, navigation,
refresh, layout, and copy. Track the serving release separately. For a
`Production only` exception, verify the specific external behavior using its
named internal account after the correct version serves it. OAuth, app
installation, payments, and push are examples. Send no real model prompts;
a scripted local test does not establish an external provider result.

Record UTC time, source/release identity, run ID, result, and sanitized
supporting evidence on the issue. Keep production acceptance open while its
required evidence is absent. The [production smoke](production-smoke.md) guide
and actual workflow define the automatic route/sign-in/read coverage; inspect
real failures and fix the responsible owner through the normal release flow.

If production breaks, fix forward with a new PR or revert through a revert
PR. Never delete deployments, revoke shared tokens, change production Neon
settings, or create paid resources without Alex.

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
