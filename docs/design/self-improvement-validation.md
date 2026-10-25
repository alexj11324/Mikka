# Controlled improvement: validation and handoff

This is an additive backend candidate based on main `c0f702f7e9f474e42d6217b7e2b0904ee02ca00d`.
It does not replace #192–#195, #208, #230 or #232. See [the spec](self-improvement.md).
Tracking: [GitHub #237](https://github.com/alexj11324/Mikka/issues/237),
automatically synchronized and read back as [Linear MIK-103](https://linear.app/bdiverifier/issue/MIK-103).

## Evidence layers

| Layer | Evidence | Meaning |
| --- | --- | --- |
| Source | Three scorer/contract/document tests | Unknown signals, immutable definitions, allowlist, negative regression |
| Actual PG17 + HTTP | One suite with nine subtests; 13 total tests including source tests | Tracked migrations, real transactions/socket requests, synthetic runs/reports/identity |
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
Reads and identical-event replay still retain old scorer/baseline versions when
the original issue/agent/repository identity remains authorized.
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

## Full CI failure diagnosed before retry

Initial complete run [40172412782](https://github.com/alexj11324/Mikka/actions/runs/40172412782)
on `6c34caf8b012d79d7296f6ab2e71644058107a96` finished **failure**. Source/lint,
typecheck, tracked-migration bootstrap and production build passed. Performance
finished **4 passed / 1 failed**; regular browser regression finished **74 passed /
1 skipped**. The existing skip is the development-preview acceptance entry,
which is absent in this production build; it is not a passed OAuth acceptance.

The sole failure is `agent-performance.spec.ts`'s initial history-request count,
expected one and received two, not its elapsed-time assertion. We read the
actual job log and its Playwright trace from
[artifact 12590464956](https://github.com/alexj11324/Mikka/actions/runs/40172412782/artifacts/12590464956).
Trace timing: reload begins at 10867.506 ms, the new main document commits at
11205.623 ms, and reload completes at 11544.802 ms. The extra history fetch
starts at 10901.711 ms before document commit and is cancelled (`status=-1`);
the actual new-document fetch begins at 11647.595 ms and returns 200. Thus the
observer included the previous fixture document's late startup fetch.

Only after confirming this evidence, the three-file observer fix was reused
from #170 `3113c3d07a543c189a82f8b9112c5158e46f5e64` (also present in #222).
It observes the main frame's new document loaders. It does not discard failed
or duplicate requests from measured documents, change a latency limit, add
retries or alter the application. Its real-browser negative control induces
a second request and verifies the unchanged one-read assertion rejects it.
The three files must be deduplicated when #170/#222 are integrated.

For #232 coordination, see the proposed
[Skill source boundary](self-improvement-skill-source-contract.md). It adds no
accepted input, trusted receipt implementation or claim of registry integration.

No deployment was attempted by this thread. The parent owns integrated CI,
fixed-version deployment, actual OAuth/Harness acceptance, production readback,
and the sanitized acceptance video on the corresponding PR. An implementation
or a green CI result cannot mark these pending gates complete.
