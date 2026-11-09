# Codex late MCP trace carrier compatibility

## Fixed source and scope
Local MCP fix d6835377c820db7d1d4e704afed2c58cdfaec789 (tree 91c499c8049ee3450a584f2e09306023b4f1010c) is a normal child of merge 16653e580d81d3d89f444affcf1a6062e47e76eb. The merge retains the complete Factory-ID fix 5ba78cc1 and exact main 0e411802. Main0e supplies the actual RunContext producer which unconditionally includes MIKKA_DECISION_MCP_TRACEPARENT, including an empty value. The old 79aa/5ba producer did not generate that key; it is not used to claim this regression.

The only product edit adds that exact key to the late-context reader's existing closed whitelist. Unknown environment keys still reject before the backend. File ownership, modes, symlink/nonce/run identity, size bounds, token handling, backend trace validation, catalogue selection, authorization and lifecycle are unchanged.

## Observed local regression
The actual producer, real private context writer, real late wrapper, real stdio tools/list and real local observation collector are exercised. With the original reader, both valid and empty carrier cases closed with exit 2 (red.log). The fixed current-lock run is green-final.log: 41/41 across the three existing related files. The exact claim catalogue comes from lib/project-map/mcp-tool.ts, loaded by its fixed source URL and checked by the existing protocol schema. catalogue-serialization-proof.json independently asserts that exported and parsed JSON bytes are equal (7327 bytes, identical SHA256).

The new tests prove backend/catalogue arrival and zero business HTTP calls. They do not independently exercise decision-call HTTP trace headers. Empty-carrier inheritance clearing and backend W3C header validation remain supported by the unchanged product chain, not presented as separately measured header tests. The local synthetic loopback observer is not zero wire and is not a live provider or production acceptance proof.

## Validation and preserved failures
Final new-lock validation: green-final 41/41, lint-final-verified zero warnings/errors on exactly three files, typecheck-verified exit 0. The daemon type check first failed because a direct app catalogue import pulled an app-only type alias into the daemon project; only the test loading method changed, without a copied fixture, fallback catalogue or production tsconfig change.

Earlier green.log used the pre-merge donor dependencies; that result is preserved but is not final new-lock proof. Main0e changed the root lock/package. The prior .vite links could route that earlier test cache to the donor; no claim is made that those prior cache writes were isolated. Only this worktree's dependency links/directories were removed, without deleting donor data. A normal frozen install succeeded with unchanged c45db74b lock after an offline cache miss. Its warnings are retained. Final dependency/cache paths resolve inside this worktree.

Two earlier lint invocations inspected zero files and failed; they are not passes. The final lint uses all original lint rules, with only the root config's packages/** exclusion removed in an ops-only config for these explicitly named files. One incorrectly short command-wrapper timeout left a complete 41-pass log without an exit receipt; that attempt is preserved and the same necessary files were repeated under a corrected bounded command before the final result. The initial TS2307 and every intermediate log remain present.

A single required complete cloud pnpm check began on this fixed source at 03:56:54 UTC. Its input, full log and result live in fullcheck-addendum, which is intentionally excluded from the immutable core manifest until termination. No claim of full-check success is made here.

## Operational boundary
No provider/model/production DB call, workflow dispatch, remote ref mutation, or new VM was performed by this task. Root alone controls publication. Historical formal failures and the unverified production result remain unchanged. Source proof and local tests do not replace the next real native subscription gate.
