# Factory task ID semantics

Local-only child of 79aa2e7411b41c506b6ce19a97f41bd68964d8cf. Three preimage blobs equal exact main 0a355918330f6dac04d2b0ee4716cd056c263162 as previously read through GitHub. No remote ref or runtime changed.

The observed caller supplied an Issue UUID as a Factory task UUID. Both pass the existing UUID format. This patch documents existing receipt provenance in the actual chat shadow and exported Factory tool. It adds no lookup, validation restriction, permission, routing or mandatory tool call. The v2 public receipt already exposes readTask.input.taskId and binding.taskId; legacy results retain task.id. dispatch_run still accepts issueId and returns a run ID. All execute callbacks, UUID/strictness and other tracked files remain unchanged.

Actual ai.asSchema tests cover named Bot and Coordinator registries plus direct Factory export. Old product with new tests is RED; final whole suite is 17/17 GREEN. Full name/description/input-schema JSON decreases 28 bytes on each scoped surface and 10 bytes on the export. This is serialized catalogue evidence, not a model request measurement or proof of future model tool choice.

First root typecheck retained 31 errors: six in new test type narrowing plus missing package dependency links. Only test annotations/string narrowing and new-worktree same-lock dependency links changed afterward. Final root tsrs --noEmit exits 0, three-file explicit lint exits 0, schema boundary passes 1/1. API/frontend types and the previously failing full pnpm check were not rerun or claimed passing. Original failure logs remain alongside final results.

The exact 8982 donor lock/package matched this tree; donor and global configuration were not modified. Initial git commit lacked author identity and failed before creating a commit; the successful retry used command-local Mikka task agent identity, preserving the failure log. No secrets, SQL, models, provider, production acceptance, scope or remote mutation occurred. P0 future botId callback changes were neither copied nor reverted; product changes are only metadata, proven by source-conservation.json.
