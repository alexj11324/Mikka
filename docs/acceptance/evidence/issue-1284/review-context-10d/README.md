# #1284 Review context and production recovery observations

This directory preserves the actual failure and its scoped repair; it does not claim production CC/Codex cross-Harness acceptance.

- Product source: PR [#1361](https://github.com/alexj11324/Mikka/pull/1361), head `10d3754a640e3b5b3ba43ed421983d047ba18e6b`, tree `ea4987de4d7f06f1ba5b961e934161adb061f001`, parent `9727fcfcfc16724e1cfcd915dc28d59b52d69481`.
- Local tested checkpoint: `9ab7ecc2b62acecfdc0c1405d0881be6af3ee03a`, identical tree/parent.
- CI [42004282276](https://github.com/alexj11324/Mikka/actions/runs/42004282276) completed successfully at 2026-11-05 09:46:38 UTC. The fixed head has 16 successful checks and one expected OIDC skip for a pull_request event.
- [Repair receipt](review-context-receipt.json): real original-code failures and final 17 unit / 47 PostgreSQL tests, the final type-only annotation ordering, and cleanup.
- [Source PR description](review-context-pr-description.md).
- [Production observation on 9727](production-9727-observation.json): ALEX67's same Task candidate was recovered without rerunning its CC producer, but Review selection returned `uncertain_profile`; ALEX66's new run remained queued before native CLI with two coarse refresh failures. Neither is labeled passed.
- [Manifest](manifest.json): exactly three candidate files, 15,046 bytes, immutable byte and Git blob hashes.

## Static credential audit scope

The three manifest files were audited at 09:50:51 UTC against the existing private isolated runner contexts for [42b](audit-42b.json) and [5251](audit-5251.json). Both passed. These audits required no database, app server, model call or new login. They are credential scans using historical runner ledgers, not new product execution on 10d. The manifest, audit reports and this index are metadata outside the three-file candidate count.

DeepSeek API remains skipped at Alex's direction. #1284 remains open until actual production requirements pass.
