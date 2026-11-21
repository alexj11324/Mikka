# Internal acceptance for production-only changes

- Date: 2026-11-20
- Source: Alex, [#2890](https://github.com/alexj11324/Mikka/issues/2890) and
  [#2891](https://github.com/alexj11324/Mikka/issues/2891).
- Status: accepted. This is the bounded exception to the shipped-feature
  default in `AGENTS.md`.

## Rule

A PR may declare `Production only` only when its changed integration cannot
be verified locally: OAuth, GitHub App or Slack App installation, payments,
or push delivery. Name the owner and existing internal account alias in its
Acceptance section. Gate that new integration with an existing PostHog
per-user flag targeted only to the `mikka-internal` cohort. Keep normal
features enabled; do not add a flag to ordinary locally testable work.

Record the flag key, owning issue, introduction date, and removal deadline in
the PR. Its lifetime is at most seven calendar days. After internal acceptance,
remove the conditional and flag in the same week. If acceptance fails, fix
forward or revert the affected change through a PR before the deadline;
expiration does not automatically expose an unverified feature. Do not widen
the cohort to turn a failed check green.

## Local and scheduled verification

`MIKKA_FLAG_OVERRIDES` is a JSON object of boolean values for local server
acceptance, for example `{"mikka-example":true}`. It applies only when
`NODE_ENV` is `development` or `test`. Production ignores it before parsing;
remote PostHog targeting and shipped defaults remain authoritative there.

Model work in every development, CI, nightly, and acceptance path uses the
shared fake LiteLLM or sanitized existing recordings. A production-only
integration check does not authorize a real model prompt or a Neon branch.

MVP tests carry `@p0` and `@journey` tags. Only the scheduled or manually
dispatched nightly workflow runs the browser journey suite, against an
isolated local PostgreSQL 17 database and the shared fake services. The API/CLI
PR policy from decisions 1520 and 2225 stays in force; adding browser journeys
to pull-request CI requires Alex's separate decision.

The default public UI slots do not provide the official workspace. Nightly
restores the official compiled renderer from the successful public service
producer for its exact main SHA, using the standard GitHub Actions artifact
token only during that read. It verifies the producer and manifest job, the
original web build job, archive/member digests, safe extraction, and the
renderer action contract. A reused web build retains its actual source,
overlay and context digest in the report; the same-source producer owns the
context equivalence decision. Nightly then compiles its local API and Eve
without rebuilding the renderer. Missing exact-source publication fails the
job; it never substitutes an older arbitrary renderer or a public empty slot.
No private UI checkout, model key, production database or deployment is part
of this workflow. A successful run proves this local composition, not a
production deployment or a real provider integration.

Deployment smoke reuses the route-registration probe from #2901. It checks
the inventory belonging to the serving API source, anonymously and without
loading business handlers. Its success proves route registration; provider
installation and internal-account business acceptance require their own
recorded observations.
