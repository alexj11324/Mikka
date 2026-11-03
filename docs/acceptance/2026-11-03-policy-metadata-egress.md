# Task policy metadata projection

The 16:27:58–16:29:47 UTC production query-counter window contained 383 repeated
task-policy hierarchy reads. `lockCliTaskScope` fetched an entire task document
each time, but only `readIssueMetadata(content).deletedAt` was used. Policy
checks may run repeatedly during active model transport.

For object documents, return the complete `attrs` object instead of the body.
Keep non-object roots unchanged. This preserves `mikka ?? orvilo`, complete
metadata-schema validation and its defaults, including invalid metadata and
existing null behavior. Do not reduce authorization frequency or reuse a
hierarchy across checks: both policy reads, guard rechecks, owner/scope/version,
row/advisory locks and membership/lease handling remain unchanged. The second
read has freshness semantics for separately stored workspace relations.
Risk: occurrence 3 × impact 3 = 9.

## Verification

- Regression test against the original SQL failed because a synthetic document
  body crossed the policy connection. Fixed SQL passed.
- Real isolated PostgreSQL socket response: 1,200,377 bytes for a synthetic
  full document versus 283 bytes for metadata. This demonstrates the path,
  not a production savings percentage.
- Thirteen metadata fixtures preserve deleted/legacy/invalid/null behavior;
  wrong-owner and missing-task checks remain refused.
- Twenty-seven real PostgreSQL/HTTP worker-authorization tests passed,
  including task/workspace policy, membership removal, STOP, expired lease,
  revoked/terminal tokens and exported MCP authorization.
- Repository lint and typecheck passed. An independent agent reviewed the
  actual diff and found no removed authority check.

Production aggregate-only context: all 264 task documents averaged 660 JSON
bytes versus 387 for attrs; this is not request-weighted. A later join of live,
unexpired, non-stopped runs found one run/task with 1,603 content bytes and
275 attrs bytes (mean/max/p95). That is a current live sample, also not a
request-weighted estimate. JSON/protocol bytes are separate from Neon billing;
no overall bill reduction is claimed from these measurements.
