# Production smoke

The acceptance account pool ([test-accounts.md](test-accounts.md)) can create,
reset fixture state, so it runs against a registered disposable database. It
cannot tell whether production works. Production smoke fills that gap the way
large products do (Meta test users, Google probers): a fixed account made
through normal sign-up, tagged as test traffic, with no extra powers, that
signs in and reads.

## The account

| Account field | Source or recorded state |
| --- | --- |
| Email | Infisical `prod:/` → `SMOKE_OWNER_EMAIL` |
| Made | 2026-10-30, through `/api/auth/sign-up/email`; verified from the Gmail inbox |
| Acceptance workspace | Alex's **Acme Inc.** team, selected through normal workspace membership and administrator verification |
| Browser conversation | The selected team's existing Coordinator; its Computer tab needs no separate bot fixture |
| API-only computer probe | The selected team's unique existing Coordinator, identified by the authorized bot-list marker rather than its display name |
| Credentials | Infisical `prod:/` (the root, which holds nothing else and syncs nowhere): `SMOKE_OWNER_EMAIL`, `SMOKE_OWNER_PASSWORD` |

The `+mikka-smoke` tag ([`lib/smoke-account.ts`](../lib/smoke-account.ts)) grants
nothing. Its only effect is that the account's PostHog events carry
`test_account: true`. The PostHog project's internal and test user filter drops
any event where `test_account` is set (configured 2026-10-30, next to the
existing cohort rule). The account loads feature flags like any other user, so
it sees what real users see.

A new smoke account is made the same way: sign up with a `+mikka-smoke-<role>`
address on an inbox you can read, open the verification link, sign in once so
the personal workspace is created, and store the email and password in
`prod:/`. Normal acceptance then uses the account's membership in Alex's team
and the subscriptions shared there, as `AGENTS.md` requires. The browser
smoke does not create a bot. Keep app secrets out of the root: the legacy smoke
job reads everything there. Do not write to the database to make or repair an
account.

## What it checks

### Retained browser smoke

This spec is retained for explicit historical/deployed-target drivers. The
ordinary `production-smoke.yml` job runs the API-only driver described next.
The repository's ordinary acceptance policy uses API/CLI checks and local
production-build screenshots.


[`tests/smoke/production.spec.ts`](../tests/smoke/production.spec.ts) signs in,
verifies and selects the shared team with the same cookie jar, opens its
Coordinator, and requires the chat composer. It reads the Coordinator,
credential-vault and approved-writes feature APIs, then checks the current
Coordinator's **Computer** tab without clicking it or starting a computer.
The Coordinator feature and every `SMOKE_EXPECT_ON` feature must still be on.
The explicit deployed-target entry requires `credentialVault,cloudComputer`.

That entry retains the before/after deployment checks and this session's normal
logout. Its closed report records `browserStage` and `failedStage` from fixed
operation names; it contains no Playwright exception, locator value, page text,
screenshot or trace. A failed run is not evidence that any particular earlier
UI assertion passed unless the recorded stage establishes it.

### API-only smoke

[`scripts/ops/production-smoke.mjs`](../scripts/ops/production-smoke.mjs) signs in
through the HTTP API, checks the session, loads the shell HTML and reads. It
uses the normal team-selection helper and its private workspace cookie, verifies
the exact owner/workspace on `bots.pollBots`, and reads the unique Coordinator's
runtime list. It
uses Node 24 without a browser. It sends no message, boots no computer and
calls no model or E2B provider.

- Fails the run: sign-in, the session, the shell response, the Coordinator
  runtime, and any feature listed in `SMOKE_EXPECT_ON` that is off.
- Reports, without failing: whether the credential vault, approved writes and
  the cloud computer are on. The table lands in the job summary.

The API-only driver has the same verified shared-team scope as normal acceptance;
it requires no historical personal `Smoke Bot` fixture or display name. Its computer probe
checks the authenticated API and server kill switch. It does not assert that a
machine can boot, that the computer tab renders or that a model can run. Those
require separate active acceptance. Reports contain only capability names and
HTTP status codes; cookies and API response bodies stay in process memory.

## When it runs

The `smoke` job in
[`production-smoke.yml`](../.github/workflows/production-smoke.yml) runs after
each successful Production deployment, daily at 14:17 UTC, and on manual
dispatch. It uses `SMOKE_EXPECT_ON=credentialVault,cloudComputer` and reads
`prod:/` through the existing GitHub OIDC identity. It writes a report and job
summary on success and failure, retaining the artifact for seven days.

The workflow's separate `deployment-comparison` job also runs every fifteen
minutes. It collects deployment windows, runtime outcomes and database egress.
Manual `audit_auth_sha` and `audit_lease` inputs select additional explicit
production authorization/lease checks, with their own exact-source guards.

Locally, with the credentials in the environment:

```sh
node scripts/ops/production-smoke.mjs
```

Inject `SMOKE_OWNER_EMAIL` and `SMOKE_OWNER_PASSWORD` through the existing secret
delivery path. Do not put credential values in shell history. The JSON report
and job summary are written to `production-smoke-report/`.

## Required active coverage

The [2026-11-07 production acceptance decision](design/decisions/2026-11-07-1400-production-acceptance-scope.md)
calls for automatic sign-in, a Coordinator message and task dispatch after each
Web deploy. The implemented automatic driver covers sign-in and reads.
`AGENTS.md` records that implementation and requires separate live messaging
and dispatch acceptance until the automatic-smoke gap is implemented. Computer
boot and model execution also need their own active evidence. Use the two
official subscription paths for model acceptance. DeepSeek/API-key work never
gates a merge. See [runtime acceptance](acceptance.md).
