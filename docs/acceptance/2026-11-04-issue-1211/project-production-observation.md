# Project production observation — issue #1211 / #1212

The existing acceptance collector also supports an explicit observational scope.
This scope includes **all production deployments in the fixed Mikka project**.
It never establishes a fixed-task before, after or idle acceptance result.

## Input and execution

Use the existing `acceptance/1211-fixed-hour-egress` branch and its existing
`acceptance-egress-hour.yml` workflow. First review and commit the collector
implementation and tests. Change the input in a separate commit with an
expected-head guard; do not combine an unreviewed implementation and collection
request. The workflow runs its unit tests before retrieving its existing OIDC
reporting credentials. It only reads the reporting APIs and writes its Actions
artifact; it does not call models, deploy or change production data.

For the requested observation:

```json
{
  "role": "observation",
  "scope": "project-production",
  "from": "2026-11-04T18:00:00Z",
  "to": "2026-11-04T19:00:00Z"
}
```

A deployment ID, expected build, workload digest or concurrency claim is rejected
in this mode. Fixed-task modes retain their existing identity, build, deployment
and concurrency requirements. Every mode still requires one completed UTC hour
within the reporting retention range.

## Meaning and limits

Vercel queries use the canonical `/metrics/v1` catalog and query endpoint,
the fixed team/project, and `environment:production`. The query groups by route
template, HTTP status and deployment ID. The artifact retains those groups,
their deployment IDs and an additional route/status rollup. A current alias and
build read is context at collection time, not a filter on the historical hour.
An alias change during collection is recorded; all production deployments in the
completed hour remain in scope.

Counts use the aggregation supported by the actual metric catalog. These are
function-invocation observability aggregates, not an independent billing ledger.
The query preserves the existing exact-mode limit of 100 groups: reaching that
limit is insufficient, not a complete total. Empty or excluded data, duplicate
groups, missing deployment dimensions, CPU/count scope disagreement and provider
refusals remain explicit failures. No zero is invented. If Neon is late, its
bucket is insufficient while successfully returned Vercel data remains in the
artifact.

Neon bytes retain the exact provider bucket start/end and reported-through time,
and include all project branches. They cannot be divided by these Vercel counts
and described as measured per-request database wire bytes. PostHog captures
require separate matching bucket evidence. Neither a capture timestamp nor an
equal byte value identifies the source hour by itself.

Preserve the checker commit, input commit, Actions run, report JSON and summary.
The requested hour may span deployments, interrupted tasks and concurrent work;
none of those facts are relabeled as a controlled before/after experiment.
