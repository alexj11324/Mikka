# Existing minute Worker

`mikka-suggestions-cron` uses one Cloudflare `* * * * *` trigger. The account's
existing Free-plan trigger limit rejected the earlier four-trigger configuration;
the Worker now dispatches the same cadences from that one scheduled event:

- UTC minutes 0, 15, 30 and 45: the reconcile safety net, operational observations
  and briefings.
- UTC minute 0: abandoned subscription sign-in maintenance and suggestions
  reconciliation.
- UTC minute 30: user facts.

Dispatch uses Cloudflare's `scheduledTime`, so a delayed invocation retains its
original cadence. Each endpoint still gets its tick if another endpoint fails.
The older individual cron strings remain accepted during deployment transition.
The current cadence comes from `cloudflare/suggestions-cron/src/index.mjs`:
`SWEEP_MINUTES` contains only `/api/cron/reconcile: 15`. A minute with no work
due sends no application request. Coordinator wakes, schedules, run recovery,
account deletion and audit retention use durable timers started by the write
that makes work due. Reconcile recovers work those timers missed; do not
restore the former every-minute endpoint fan-out. Endpoint idempotency and
authorization are unchanged. Successful supplier collection retains its
quarter-hour cadence and existing claim and failure retry deadlines (see
[suggestions schedules](../suggestions-cron.md)).

Deploy the existing Worker only after the matching Mikka application is READY
and its tracked migrations have run. Keep the existing native-synced
`CRON_SECRET`, canonical `MIKKA_URL`, disabled public Worker/preview URLs and
observability. No new Worker, paid plan, identity or secret-delivery mechanism is
required. Verify the remote trigger list and secret-binding presence after
deployment; record actual production observation separately from source tests.

## Automated main release

The **Minute Worker** workflow (`.github/workflows/suggestions-cron.yml`) runs
source tests on pull requests. Its deployment job runs only for this
repository's main branch, after the existing exact-commit main CI gate. It reuses
the current GitHub OIDC identity and the existing Cloudflare account/token and
read-only Vercel team token in Infisical `prod:/platform`. It does not retrieve,
upload or rotate `CRON_SECRET`; native Secret Sync remains its writer.

Before a write, the release checks that the fixed Worker already exists, has
only the expected `MIKKA_URL` and `CRON_SECRET` bindings, has one minute trigger,
has observability enabled, and exposes neither its workers.dev nor preview URL.
It rejects mismatches before invoking Wrangler. The fixed Vercel project and
alias must be READY, have a successful **Web deploy** run for that deployed
commit, and return that same commit from the public `/mikka/api/version`.
A newer main commit is accepted only when it contains this release and leaves
all Worker/release inputs unchanged; a newer change to those inputs supersedes
the old release. Main, deployment and public build are checked again before the
write.

Wrangler updates this existing Worker once, using `--keep-vars` and the
repository's fixed config. Deployment preserves existing secret bindings;
no secret file or new resource is supplied. The release then verifies that its
returned version is active at 100% and rechecks the bindings, single trigger,
URL flags and observability. An uncertain upload or failed readback stops the
job without retrying the write. The logged receipt contains only source/build
SHAs, deployment/version IDs and configuration checks.

Use the main-only workflow dispatch for an intentional release of the current
main. Every normal main push now builds Web, including documentation changes.
An ordinary manual Web dispatch can still skip a documentation-only change.
A skipped build cannot satisfy the matching-application gate. After an uncertain write, inspect the active
version read-only before deciding whether another release is needed.

## Runtime observation

A successful release receipt proves deployment identity and configuration,
not that each scheduled endpoint has run. Record normal scheduled Worker
history and the matching production route logs separately. Check a UTC
quarter-hour for reconcile, ops-monitor and briefings, an hour boundary for
subscriptions and suggestions reconciliation, and minute 30 for user facts.
Observe normal due-time Workflow executions separately for coordinator wakes,
schedules, run recovery, account deletion and audit retention. Preserve their
existing authentication and failure behavior. Do not invoke production cron
routes manually to manufacture observation traffic or include secret values
in evidence.

Provider references: [Wrangler deploy and secret preservation](https://developers.cloudflare.com/workers/wrangler/commands/workers/),
[Worker subdomain flags](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/),
[Worker script schedules](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/).
