# Codex native execution proof: focused RED/GREEN

Base: 869c71d7aa062c76fc7a75c1f8775d1ed8538168. Proposed unreferenced child: a7092db9a0328c6eeb467101c01f4836be0d1809; tree: 27321a39cd8e1cb6e1ee4a2d5eb96bd696479b8b. Only scripts/acceptance/cloud-startup.mjs and scripts/acceptance/cloud-startup.test.mjs change.

The exact Codex adapter emits available outputs for native command and file-change completions even when exitCode is nonzero/null or patch status is failed. The acceptance driver previously treated that availability as successful execution. This correction only changes its successful-execution set for record.harness === 'codex' and exact native tool names bash/apply_patch. It requires exitCode === 0 or status === 'completed'. Other harnesses, ordinary MCP outputs, wire chunks, and the existing redacted audit retain their behavior.

The prepass uses only the first 64 candidate call IDs after a valid agent_start. An already-admitted ID can acquire a late native name after that cap; an identified native name cannot be downgraded by a later unknown name. A later failed available result removes earlier success for that call.

Eight focused tests import the full real driver and fixed public driver dependencies. Their regression bodies are identical to the eight tests appended to the complete original cloud-startup.test.mjs. The focused harness reuses the original stage, delta and submittedReply fixtures. No production implementation is stubbed. Coverage includes native positive/negative outcomes, unknown/null/missing values, late names at the 64-ID boundary and pre-start noise, attempted name downgrade, a success-to-failure available update, canonical submit-report delivery, compatibility with other harnesses/MCP, handoff exclusion, explicit error rejection and redacted reports.

Command: node --test focused-native-tool-proof.test.mjs
Environment passed to that command: PATH only. No production credentials or network/model/DB requests.

Canonical RED: 6 failed, 2 passed, exit 1.
Canonical GREEN: 8 passed, 0 failed/skipped, exit 0.
Full stdout/stderr and result JSON are in verification/red.* and green.*. environment.json records Node 24.22.1 and the executable SHA256; file-hashes.json records the exact tested bytes.

The first materialization introduced one extra trailing newline. It was detected by comparison to the base Git blob, removed, and RED/GREEN were rerun. The canonical RED driver blob exactly equals the original base blob 5b5dd2d6b06f5b26f2c04db31cbc99a1b265ce63. Earlier unnormalized results are retained under initial-materialization and are not the canonical evidence.

The full existing test suite was not executed in this fixture: @opentelemetry/sdk-trace-base and zod are not installed here. The original tests are preserved intact for root's complete checkout/CI. No packages were stubbed or installed to evade that distinction.

Official protocol: rust-v0.166.0 resolves to commit 6ff1e1ca3b30fc8b914720681fcf5fe62e95f856. PatchApplyStatus is inProgress|completed|failed|declined; McpToolCallResult has content, structuredContent and _meta, with no isError field. This change makes no MCP/protocol or production-adapter changes.

Local anonymous startup source uses the same rawCliShellAvailable predicate as cold startup. Native shell is disabled for readOnly or non-allow installation policy; adoption checks the policy snapshot hash and only adds MCP thread configuration. That local source fact does not establish the cause of a previous submit-only or ended-before-proof run, nor does it establish the upstream late-MCP catalogue semantics.

