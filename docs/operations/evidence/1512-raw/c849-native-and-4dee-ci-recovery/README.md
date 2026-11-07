# Issue 1512 — c849 Native and 4dee CI recovery

This immutable archive preserves six exact original JSON files from Desktop run 42396413807, their unchanged-reader projections, both final CI receipts, and source recovery provenance after the local executor became unavailable.

## Exact source boundaries

- c849 Native: candidate `c8499fc2c59d779ffd8e7e5de4618b409b6e776f`, actual source `d93368760b73fdc353654f1405303c7957379aa6`.
- c849 CI: run `42396413854`, actual source `d93368760b73fdc353654f1405303c7957379aa6`.
- 4dee CI: run `42399391020`, candidate `4dee10cc9fc4e29dd5859ae49bb3a8ea51d9b431`, actual checkout `817480a70ada3b66fca2cf55e9cf7b0d5e2d350a`, tree `b907cf48fc48c82351fe2e141970fbf77bc12ed8`.

Native login totals are 209/209; first startup totals are 140/199 in the original windows. Three bundled-startup physical RPCs cross the end of their window, so the startup difference is not evidence of a reduction in complete work. The hosted startup renderer runs in the same Electron shell. Both nativeLogin unknown-action rows contain an explicit null `rpcAction`; the readers preserve it.

Both CI runs passed all 69 PostgreSQL suites and 3304 tests with no skips and successful container cleanup, but failed in the API test file process. The final receipts preserve those failures. No root cause or successful fix is claimed here.

## Recovery and privacy

Three original artifact ZIP hashes, six JSON hashes and Git blob identities were checked before retention. ZIPs and signed URLs were not retained. The derived projections were regenerated from unchanged readers after the executor outage; they are identified as derived, not original local output. All retained original and derived payloads were read back from GitHub and compared exactly.

`source-recovery.json` records which local logs remain unavailable. Their earlier observed hashes and exit codes do not reconstruct their original bytes. The recovered source tree matches the observed local tree, while the new remote commit identity is explicitly different.

No production acceptance is claimed by this archive. Issue 1512 remains open.
