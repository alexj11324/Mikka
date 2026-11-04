## Fixed-hour egress collection: insufficient

Production acceptance: not established by this collector.

Reasons: metric_groups_missing_or_truncated.

Role: observation.
UTC window (end exclusive): 2026-11-04T18:00:00.000Z → 2026-11-04T19:00:00.000Z.
Scope: all production deployments in the fixed Mikka project; no fixed-task comparison is established.

Neon hour bytes: 60516203. Reported through: 2026-11-04T19:00:00.000Z.
Coverage: requested_hour_returned; scope: all branches in the fixed project.

- This is a project-wide production observation, never a fixed-task before, after or idle acceptance window.
- The completed hour can include multiple deployments, concurrent work and interrupted tasks; alias/build reads are collection context only.
- Vercel values are function-invocation observability aggregates, not an independent complete billing receipt.
- Neon project bytes include all branches; PostHog bucket alignment requires its own matching provider-hour evidence.
