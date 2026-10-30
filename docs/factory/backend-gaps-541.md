# Candidate delivery details (#541)

The existing task-detail response (`GET /api/factory/tasks/:taskId`) adds:

| Field | Source |
| --- | --- |
| `delivery.pullRequest.title` | GitHub's PR response when the delivery is published. The signed `pull_request` webhook refreshes title and state for the exact saved repository/PR URL. Older deliveries can lack the title until a webhook arrives. |
| `delivery.previewDatabaseBranch` | The producing run's reported preview database branch, snapshotted with the candidate. `null` if none was reported. |
| `delivery.machineName` | The producing run's owned device name at candidate capture. Cloud machines use their registered device name. Later renames do not rewrite deliveries. `null` for historical candidates or a run without a device. |
| `checks[].criteria[].command` | The reported command for that criterion; the run's existing `verify.command` is the fallback. Both are redacted before return. |
| `checks[].criteria[].exitCode` | The reported integer exit code for that criterion command, or the run's verify exit code when the criterion has no command. `null` when unknown. |

The `submit` tool accepts `previewDatabaseBranch` only when a preview branch was
actually created or used. Each criterion can include `command` and `exitCode`.
These fields survive MCP handoff, daemon validation and the stored run report.
They are descriptive agent evidence: they do not replace the daemon-owned
`verify` result or grant publication authority. The frozen verification command
continues to run as before.

Migration `20261030233001_factory_candidate_details.sql` adds two nullable
columns to `factory_candidates`, with no new table or backfill. PR titles stay
in the existing publication JSON. The existing UI can adopt these response
fields separately; no component changes are included.

Validation covers GitHub title capture, signed-webhook update projection,
foreign repository/URL rejection, real PostgreSQL task detail and candidate
snapshot persistence, legacy command fallback, protocol preservation, and MCP
handoff. Provider traffic in tests uses explicit fixtures.
