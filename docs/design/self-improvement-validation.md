# Controlled improvement: validation and handoff

This is an additive backend candidate based on main `c0f702f7e9f474e42d6217b7e2b0904ee02ca00d`.
It does not replace #192–#195, #208, #230 or #232. See [the spec](self-improvement.md).

## Evidence layers

| Layer | Evidence | Meaning |
| --- | --- | --- |
| Source | Three scorer/contract/document tests | Unknown signals, immutable definitions, allowlist, negative regression |
| Actual PG17 + HTTP | One suite with eight subtests; 12 total tests including source tests | Tracked migrations, real transactions/socket requests, synthetic runs/reports/identity |
| Existing migration checks | 33 migration files and 11 policy/order tests | No renaming, rewriting or duplicate timestamp |
| Static lint | Targeted oxlint with denied warnings; diff whitespace check | Source hygiene |
| Remote CI | PR exact-head checks | Full typecheck/build/browser regression plus dedicated PG17 suite |
| Independent review | Read-only reviewer of this candidate | Source correctness; not Harness acceptance |
| Fixed Preview, real OAuth/Harness | Pending parent integration | Required before system acceptance |
| Production user flow and PR video | Pending parent release coordination | Required before user-facing completion |

PG/HTTP checks exercise ten concurrent identical feedback submissions, conflicting
payload rejection, owner/issue/agent/repository isolation, current access denial,
stopped/cancelled runs, source cancellation after scoring, unknown positive
signals, 24/25 distinct-failure boundary, six/eight-day age boundary, forced SQL
failure after proposal insertion with full rollback, ten concurrent proposals,
connection-pool recreation and HTTP readback. Stored scorer versions and scores
reject rewriting; duplicate version with changed definition fails. Candidate bytes
never contain the adversarial feedback note. Synthetic comparison explicitly
reports `independentVerification=false` and `productionEligible=false`.
Moving a run to a different issue also hides the old bucket's snapshots and
rejects replay of feedback originally recorded against that earlier issue.
Replaying the new migration after its SQL committed also succeeds, covering
an interruption before the existing migration runner records its ledger.

An independent review found that initial lifecycle foreign keys would block the
existing Agent deletion cascade. Source run/issue identifiers are now snapshots,
with no foreign keys into live application entities; PG catalog checks verify
this without deleting data. Internal immutable-ledger foreign keys remain.
The first test fixture used an invalid issue status and failed at bootstrap;
it was corrected to the existing `todo` enum before the passing runs.

## Reproduce without application credentials

Use a disposable PG17 service on loopback with database `mikka_improvement`.
Set **only** `IMPROVEMENT_TEST_URL` for the test command (never an application
database URL). The suite rejects remote hosts and a different database name.

```sh
node --import tsx --test lib/self-improvement/scorer.test.ts lib/self-improvement/postgres.test.ts
node_modules/.bin/oxlint lib/self-improvement lib/issue-access.ts app/api/self-improvement --deny-warnings
node scripts/check-migrations.mjs
node --test scripts/check-migrations.test.mjs scripts/migration-order.test.mjs
git diff --check
```

The PG suite skips explicitly if the dedicated variable is absent; the dedicated
CI job sets it to its own disposable service. The suite uses all tracked SQL,
not an invented schema, and retains its synthetic test schema for inspection.
It never reads cloud/application credentials or calls a paid model/provider.

## Parent integration contract

Only shared-file increment: `issueForUser`/its internal finder accept an optional
`Pick<typeof db,'select'>` executor and use it for the existing select. This is
byte-for-byte equivalent to #192's already proposed optional executor increment;
do not apply it twice. No access logic changes.

No imports from the parallel Factory or Skill registry branches. The new SQL
depends only on main's existing base entities and has a later unique timestamp.
API is `/api/self-improvement`, with session identity, same-origin POST, strict
input and a 16 KiB streaming body limit. No new Coordinator tool, wake or external
operation is registered. The parent can add this API to the existing authenticated
chat flow after contracts are integrated; this candidate makes no claim that a
chat can already invoke it.

For an actual Skill iteration, #232 must supply digest-pinned run usage. A human
must review the diff, create a real commit through existing code delivery, and
submit the resulting SHA/repository/environment/scope to #192/#193/#194. Never
turn synthetic document comparison into a review/verify pass or publication
approval. Evidence retention/erasure remains a #210 coordination item; this
candidate performs no data deletion and does not add a delete API.

No deployment was attempted by this thread. The parent owns integrated CI,
fixed-version deployment, actual OAuth/Harness acceptance, production readback,
and the sanitized acceptance video on the corresponding PR. An implementation
or a green CI result cannot mark these pending gates complete.
