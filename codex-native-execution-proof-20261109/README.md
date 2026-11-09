# Codex native execution proof — a709 validation

This directory preserves acceptance-only evidence for unreferenced source commit `a7092db9a0328c6eeb467101c01f4836be0d1809`, tree `27321a39cd8e1cb6e1ee4a2d5eb96bd696479b8b`, sole parent `869c71d7aa062c76fc7a75c1f8775d1ed8538168`. Only `scripts/acceptance/cloud-startup.mjs` and its test file change. The evidence commit is prepared as a child of `8a08c8c77e1525a0e0b1eb9f4e92e2d1d28b7503`; no ref is moved by this preparation.

## Results and scope

| Run | Actual source | Scope | Result |
| --- | --- | --- | --- |
| Canonical focused RED | Exact original 869 driver blob `5b5dd2d6b06f5b26f2c04db31cbc99a1b265ce63` | Eight new native-proof regression tests | 2 passed, 6 failed, exit 1 |
| Canonical focused GREEN | Exact a709 driver blob `6753c8aa8adf4354b60be3d62dcc5d5458f36cd9` | Same eight regression tests | 8 passed, 0 failed/skipped, exit 0 |
| Root full related GREEN | Complete a709 checkout after the frozen install on 869 | Five complete related test files | 194 passed, 0 failed/skipped, exit 0 |

These are distinct runs. The 194 result does not claim a full-repository PostgreSQL/typecheck gate or a real subscription/model/production acceptance run. No new VM, production credential read, production log read, or model call was performed for this archive.

The focused tests import the full driver with four dependencies materialized from fixed public source, not a rewritten implementation. Those four dependency copies each retain exactly one extra EOF newline; `focused/dependency-bindings.json` records both their actual tested hashes and original Git-source hashes. No other dependency byte differs. Their test bodies are the eight regressions added to the full original test file, which remains intact. The isolated fixture lacked unrelated packages needed by the full existing suite; root subsequently installed the frozen repository dependencies and ran the full related suites. The original fixture README is preserved under `focused/README.md` as a historical record of that earlier scope.

## Exact commands and originals

Focused command: `node --test focused-native-tool-proof.test.mjs`. The focused subprocess received PATH only. Complete stdout/stderr, exit codes, source/test hashes, Node executable hash, and the canonical tool result are under `focused/`.

Root used `corepack pnpm install --frozen-lockfile` at 869, with a 420-second timeout and production-related environment variables unset, then switched the complete checkout to a709 without dependency changes. The original install output records 75.9 seconds and pnpm 10.34.3. The archive-time default PATH executable reports pnpm 11.25.0; it was not the installer. Installation warnings are retained verbatim, including absent generated daemon CLI bins and ignored optional dependency build scripts.

Root's exact test command, on Node 24.22.1:

```sh
node --import ./tests/support/server-only.mjs --import tsx --test scripts/e2b/runtime-report.test.mjs scripts/e2b/validate-template-subscriptions.test.mjs scripts/e2b/publish-template-env.test.mjs scripts/acceptance/cloud-startup.test.mjs scripts/release/web-deploy.test.mjs
```

The unmodified full stdout, empty stderr, exit file, frozen-install output and root's source/hash metadata are under `full-related/`. `manifest.json` hashes every archived file except itself. `patch.diff` was regenerated from the exact Git objects; no product files were changed during archival.

## First materialization correction

The first file materialization appended one extra EOF newline to the original driver, patched driver, full test file and focused runner. Those first results are preserved under `focused/initial-materialization/`, but are not used as exact-source evidence. SHA256 and Git-blob comparisons detected the mismatch. Exactly one EOF newline was removed, and both RED and GREEN were actually rerun. The canonical RED driver is byte-identical to 869. During archival, all four initial hashes were independently checked against canonical bytes plus exactly one newline. No first-round result is relabeled as an exact 869 run.

Archival checks additionally identified one retained EOF newline in each of the four fixture dependencies. Those copies were not changed and tests were not rerun during archive preparation. Thus the canonical focused driver is exact but the focused fixture is not claimed to be a byte-identical repository tree. Root's independent full related GREEN ran the exact a709 checkout and has no such materialization qualification.

## Behavior and protocol boundary

Codex native command/file-change completions can be available without a successful native outcome. a709 requires exact numerical zero for `bash` and exact `completed` for `apply_patch`. It preserves ordinary MCP/other-harness behavior, handoff exclusion, redacted audit fields and wire chunks. It does not modify the production adapter, schema or SQL. Native identity is resolved across replay within the same first 64 post-start candidate IDs, including late names, and cannot be downgraded by a later unknown name.

Official OpenAI Codex tag `rust-v0.166.0` resolves to commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. Primary protocol sources:

- https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/schema/typescript/v2/PatchApplyStatus.ts
- https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/schema/typescript/v2/CommandExecutionStatus.ts
- https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/schema/typescript/v2/McpToolCallResult.ts

`static-review.md` records the verified prepass boundaries and one preexisting synthetic contradictory-terminal ordering limitation. That limitation is not established as real provider behavior and was not folded into this patch. Neither these tests nor the local source review establish the cause of earlier production failures.
