# Codex 0.167.0 compatibility evidence — #1505

This archive preserves the exact offline version-guard regression and fixed upstream source review. It is not production adoption, a successful release, or formal dispatch-to-agent acceptance.

The product base is `12458fe22e1217f644e8b28f82ab856211e73b72`. The production change permits only Codex `0.166.0` and `0.167.0` during anonymous initialization. Unknown versions remain rejected before `initialized`; fresh identity, environment, one-shot adoption and revocation checks are unchanged. The original official-template decision record is updated in the same patch.

## Actual results

- Old guard with new synthetic IPC tests: 29 passed, exactly the three new 0.167.0 positive cases failed with `Anonymous Codex version unavailable`, zero skipped.
- New guard: candidate, hosted adapter and configuration protection suites passed 60/60, zero skipped.
- Daemon typecheck: exit 0.
- Final changed-file lint: 3 files, 97 rules, zero errors or warnings; root rules retained and ignorePatterns emptied so the files were actually linted.
- **Full `pnpm check`: FAILED, exit 1.** The fixture VM had no PostgreSQL service; checks failed connecting to `127.0.0.1:5432`. This archive makes no full-check PASS claim.
- Linux, non-root uid 1000, actual Node 24.22.1. Fixture OAuth values and RPC responses are synthetic; no real models were run.
- Temporary Sandbox `sbx_IPHpRiaKnbhf6KVqsukrUZYTnRbb` was stopped at `2026-11-09T21:12:31.817Z`; both stop and subsequent GET receipts say stopped.

`raw/` holds the frozen original evidence files. The three gzip archives use reversible base64 wrappers; their original bytes and hashes are in the manifest. The Linux archive was checked member-by-member against its extracted files. The original 70-file source manifest is preserved verbatim.

`official-protocol-review/` preserves the prior fixed-commit review and its complete source manifest. All 17 cached official source files were independently checked for exact byte length, SHA256 and Git blob OID. Large upstream files remain referenced by immutable commit/path/hash instead of being duplicated here. This is source compatibility review, not a claim that real 0.167 binaries were exercised.

`independent-review.json` records the final four file identities and medium merge risk. The final post-test changes were the ADR subscription wording and one explanatory hosted-test comment; runtime tests were not repeated for those wording changes.

The original production failure is preserved in the preceding evidence commit under `main7848-subscription-failure-20261109/`. Its diagnostic did not contain the native anonymous initialize response; the version rejection is a concrete source-level mechanism corroborated by the offline RED, not a reconstructed production trace.

Next gates remain: exact-head CI, unchanged official files, real Claude Code and Codex subscription and adoption gates, then six fresh ordinary production tasks on one exact APP/DPL/runtime/worker/template tuple, each complete dispatch-to-agent interval <=5000ms. Formal samples from this archive: 0.
