# Historical main runtime release: f3ef8f4

This is historical failed release evidence, not issue #1512 production acceptance.

- Source main: f3ef8f4a5f96909e84a719ab3cd4cf2515d57602.
- E2B workflow 42340744387 failed its subscriptions job. The Claude receipt passed; the Codex receipt stopped before execution proof. Publication was skipped.
- The original subscription diagnostic records failed device cleanup at that time. The original release cleanup receipt records all three private candidate sandboxes deleted, no remaining sandbox IDs, and no cleanup errors.
- A later bounded, read-only database query at 2026-11-07T05:36:38.797429Z found the exact historical device removed at 2026-11-07T05:36:28.117362Z, disabled, with zero active runs, bound tokens, or associated tokens. This task did not perform that removal. The result establishes the observed later state, not which actor removed it.
- The query and closed result contain only the known device ID, timestamps, enabled state, and counts. No user text, secrets, or token hashes were retrieved.
- The failed receipt alone does not establish an exact provider or initialization root cause. The later upstream compression fix has its own separate controlled evidence.

