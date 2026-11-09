# Startup blocker verification evidence — 2026-11-09

This directory preserves project text evidence after the primary workspace became unavailable. It is an additive snapshot under the existing inert evidence branch. It does not change product code, workflows, deployment configuration, or any branch reference by itself.

## Fixed code identities

- Published PR1788 head: `9ef8cb26d5f131da1fc05a9644c9d7b9e9015cc8`; tree `91c499c8049ee3450a584f2e09306023b4f1010c`.
- Tested local MCP child: `d6835377c820db7d1d4e704afed2c58cdfaec789`, with the same tree.
- The local normal merge `16653e580d81d3d89f444affcf1a6062e47e76eb` retains Factory-ID semantics commit `5ba78cc1c930c7c78869e2e133c2581b925d32f0` and exact main `0e4118020311ae8f9083d0d21cfb990be0282f25`.
- Remote Factory-ID equivalent: `b293885a0945807995bd6cb8054e04f2e739085b`, tree `0af9e4bfdbebccf75516f79fd5df35ad806e80c0`, parent `79aa2e7411b41c506b6ce19a97f41bd68964d8cf`.

The evidence branch retains its older product snapshot. These references identify the actually tested and published code; the evidence branch itself is not a new product candidate.

## Results and limits

Factory-ID semantics: the original RED, final 17-test result, schema/metadata-byte checks, lint/type results, and independent peer are retained. Tool descriptions distinguish an existing Factory receipt's task ID from an Issue ID without adding a mandatory tool call or changing execution SQL.

Late MCP context: the original real producer→writer→late-wrapper regression failed with exit 2 for valid and empty trace carriers. The final new-lock related suite passed 41/41; explicit three-file lint and daemon types exited 0. The actual exported claim catalogue and protocol-parsed value had identical serialized bytes and SHA. These tests cover tools/list and the real local observer; they do not separately establish decision-call HTTP trace headers or live provider acceptance.

The one complete cloud pnpm check on the final combined tree **FAILED**, after 389.163 seconds. Its first 27 main commands completed; command 28, test:view-state, failed because the Settings fixture mock lacked SuggestionsRefresh; the following 56 commands did not run. A separately authorized, one-file test on exact main0e reproduced the same error. The 81 resolved direct source/config blobs and normalized first error stack matched. This actual error is not relabelled as the older authClient fixture failure.

Earlier warnings and failures are preserved: initial dependency/type problems, two lint attempts that inspected zero files, direct-import app-only type alias failure, the offline install cache miss, normal install warnings, and a prematurely limited wrapper attempt without an exit receipt. An earlier green result used prior donor dependencies and is not final current-lock proof. The later new-lock validation and private cache layout are explicitly recorded.

The original 0a subscription diagnostics and cleanup JSON are retained as closed evidence, including the actual failed gate. Local code tests and a published PR do not turn that historical result into a passed runtime release.

**No new formal six-case acceptance was executed in this checkpoint (0); the historical six FAIL results remain unchanged.** This archival operation makes no production request and does not perform an account login, model call, SQL query, workflow dispatch, or ref update.

## Included and excluded bytes

file-index.json lists every included original text member with its original path, bytes, mode, SHA256 and Git blob ID. Original manifests are retained byte-for-byte; they can reference intentionally excluded members, so their member lists must not be interpreted as this archive's included-file set.

excluded-index.json lists the five Git-backed source diffs and two binary ZIP files excluded from this snapshot. The source commits and exact blobs retain the product/test code; the original diff hashes remain recorded. Extracted closed production JSON is included instead of ZIP binaries. No checkout, dependencies, environment files, private compiler log, screenshot, or unrelated directory was copied.

Transport and archive verification use exact byte lengths, SHA256 for each transfer block and complete transfer, each original text member's SHA256, and remote Git blob/mode/size readback. The bounded scan covers likely GitHub tokens, private keys, signed URLs, credential-bearing database URLs, bearer values and JWTs. It found no suspect values in included members; it is not a general security-audit claim.

The still-active primary-recovery/production-traces subtree is NOT included in this commit. This includes the main-0e-boundary recovery and any dependency/MCP review recovery being prepared by its owner. Those reports are not claimed as durably saved here; a separate later additive commit can preserve them after freezing. No new CI failure log is included.
