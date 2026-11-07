# Production smoke

The acceptance account pool ([test-accounts.md](test-accounts.md)) can create,
reset and wipe accounts, so it only runs against a disposable CI database. It
cannot tell whether production works. Production smoke fills that gap the way
large products do (Meta test users, Google probers): a fixed account made
through normal sign-up, tagged as test traffic, with no extra powers, that
signs in and reads.

## The account

| | |
| --- | --- |
| Email | Infisical `prod:/` → `SMOKE_OWNER_EMAIL` |
| Made | 2026-10-30, through `/api/auth/sign-up/email`; verified from the Gmail inbox |
| Acceptance workspace | Alex's **Acme Inc.** team, selected through normal workspace membership and administrator verification |
| Browser conversation | The selected team's existing Coordinator; its Computer tab needs no separate bot fixture |
| Historical API-only fixture | `Smoke Bot` in the original personal workspace; used only by the legacy API-only driver described below |
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

### Browser smoke

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

### Legacy API-only smoke

[`scripts/ops/production-smoke.mjs`](../scripts/ops/production-smoke.mjs) signs in
through the HTTP API, checks the session, loads the shell HTML and reads. It
uses Node 24 without a browser. It sends no message, boots no computer and
calls no model or E2B provider.

- Fails the run: sign-in, the session, the shell response, the Coordinator
  runtime, and any feature listed in `SMOKE_EXPECT_ON` that is off.
- Reports, without failing: whether the credential vault, approved writes and
  the cloud computer are on. The table lands in the job summary.

This API-only driver still finds the historical `Smoke Bot` by name and reads
its runtime list; it does not select or establish the browser's shared-team
scope. It is not a substitute for team-bound acceptance. Its computer probe
checks the authenticated API and server kill switch. It does not assert that a
machine can boot, that the computer tab renders or that a model can run. Those
require separate active acceptance. Reports contain only capability names and
HTTP status codes; cookies and API response bodies stay in process memory.

## When it runs

[`production-smoke.yml`](../.github/workflows/production-smoke.yml): after each
successful Production deployment, daily at 14:17 UTC, and by hand. The job
reads `prod:/` through the existing GitHub OIDC identity.

Locally, with the credentials in the environment:

```sh
node scripts/ops/production-smoke.mjs
```

Inject `SMOKE_OWNER_EMAIL` and `SMOKE_OWNER_PASSWORD` through the existing secret
delivery path. Do not put credential values in shell history. The JSON report
and job summary are written to `production-smoke-report/`.

## Next

- An active tier behind a flag and a spending cap: send one message, wake the
  bot's computer, run one browser sub-agent task.
- A peer account (`+mikka-smoke-peer`) for invitations and thread privacy.
