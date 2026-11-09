# M1 E2B failure correlation: local diagnostic patch

This package preserves a two-file local patch against source tree `8c5c12ea993533403d13e21dc75647bb28022767` (production M1 `01a6bfb3a6c537e2b466911f57429f109b418aa8`). The isolated checkout uses a local snapshot commit, not the production commit identity. No shared source/index, branch, CI, model, VM or account connection was changed.

## Result

The failed candidate JSON now retains the existing submission-only HTTP trace ID, workflow ID and closed dispatch-refusal code even when no run was created. A matching source commit and harness are required. Invalid identifiers become null; unknown refusal values become the literal `unknown`. No prompts, tool input/output, credentials or unrelated IDs are copied. Success rows retain their existing shape.

The public file-writing seam reproduced the loss on the original runtime: two tests failed. The final workflow-canonical command, `node --import tsx --test --test-reporter=tap scripts/e2b/validate-template-subscriptions.test.mjs scripts/acceptance/cloud-startup.test.mjs`, passed 99/99. Explicit no-ignore lint passed. An earlier invocation without the required tsx loader failed to import a package; that original failure is retained. The two identifier-red files were initially misnamed but contain a passing execution; the identifier-check copy is the same log, not another execution.

## Production boundary

The original subscription gate remains failed. Root separately recovered Claude's persisted `dispatch_run` refusal as `githubNotConnected`; this child only maps its exact source and normal connection flow. Root observed a completed Codex turn with `get_factory_task` and no dispatch; its exact persisted error code remains unresolved in this package. `source-diagnosis.safe.json` clearly attributes those findings to the parent and preserves their limits. The missing bootstrap proof is downstream of failure before dispatch. No speculative stream-parser change is included.

Normal resolution is to keep the designated SMOKE Mikka identity and use Plugins > GitHub > Link GitHub. The accepted ADR allows multiple Mikka users to authorize the same GitHub identity through that normal OAuth flow. Team model subscriptions do not share GitHub credentials. Do not copy another user's sealed token or switch the acceptance identity. Readiness can be checked through the existing authorized read-only GitHub endpoint, projecting only connection state and membership of the exact expected repository. This package performs no authentication or readiness request.

## Files and reuse

`startup-correlation.patch` contains only the validator and its existing test file. `final-source-manifest.safe.json` binds before/after blobs and unchanged source references. `implementation-receipt.safe.json` links all actual verification results; `review-index.safe.json` lists every evidence file by bytes, SHA-256 and Git blob. `checkout/` and its read-only dependency symlink are not public payload. Original production private logs and artifacts are not copied; only their existing hashes and metadata are referenced. This patch does not fix the separate current Native SQL budget RED or establish any release/production PASS.
