# Computer events WIP checkpoint

Saved before leaving the temporary Vercel test environment. This is not a production acceptance result.

Base: a4f64527970e124b9e4d597fd528baa3c6c34c78 (Factory live channel PR #1220).

The 15 source/test files were compared with the actually tested environment by SHA-256; all matched. Seven new unit/real-PostgreSQL cases passed with zero skips. Typecheck and lint exited 0. The existing backend database case passed. The unattended regression invocation exited 1 because it omitted Node's required --experimental-test-module-mocks flag; it must be rerun with the correct invocation. No unattended pass is claimed.

Pending before review/merge: actual revoked-session/membership route regression, writer post-commit/rollback integration coverage, preview fixture adaptation, CI test inventory wiring, local production-build screenshots, latest CI, required one-hour before/after production measurements, Web deploy and production acceptance. No production merge or model call was made for this checkpoint.
