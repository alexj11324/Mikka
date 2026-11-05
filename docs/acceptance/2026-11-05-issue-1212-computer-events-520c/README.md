# C computer events: main integration at 520c397e

Related tracking issues: #1212 (C), #1211.

## Source identity

- Reviewed source commit: `520c397e2f58cdc69dd5c6d75f6e8d83ffe2b103`.
- GitHub and native staged Git tree: `c342a69139192ce077a7738707aec788579c51e1`.
- Ordered parents: original C head `b12750d5b7006c6dbc7c7b5bec7acf8ace1b51ed`, then main `3adee90c742b045e0eebd5854eecc6ade1c84aae`.
- All 29 changed files were exported, independently checked by SHA-256 and Git blob hash, uploaded by content address, and assembled into the identical full tree. The original branch advanced with an expected-head compare-and-swap, without force.
- The 29-file delta is the original 28-file C scope plus one integration fixture in `lib/live/pending-actions.db.test.ts`. The latter requires both committed `pending_actions` and `subagent_events` payloads, including their exact scope. It keeps rollback and replay assertions.

The four true merge conflicts retained both producer imports, all main live event kinds plus C's kind, and both sides' database test entry points. Current main list/pending/computer/approved-write consumers, live-ready negotiation, monotonic time and request-context handling are retained.

## Checks and preserved failures

All commands ran in the authorized Vercel cloud Linux fallback, Node 24.22.1 / PostgreSQL 17.11, with unique loopback *_e2e databases. The local bootstrap role already existed; no role grants were changed. This is not evidence that the full suite works with a minimal-privilege database role.

| Stage | Actual result | Meaning |
| --- | --- | --- |
| Initial a18 integration | live DB 67 tests: 65 pass, 2 fail | One credential producer subcase and its parent still expected only the pending-actions event; C correctly also emits subagent-events. All raw failures remain. |
| Initial 3ad integration | live DB 79 tests: 76 pass, 3 fail | Two lists subcases and their parent failed while importing auth with an HTTP loopback origin; the passwordless local URI does not qualify for the app's explicit local account mode. This was a harness configuration failure, not a reason to weaken auth. |
| Initial 3ad type check | exit 2 | The new fixture comparator indexed an unknown event value. It now uses the existing JSON-string comparison pattern, retaining exact deep equality. |
| Intermediate CI-flag diagnostic | affected DB 20/20; types/lint/diff exit 0 | Preserved as a diagnostic run. It does not establish an authenticated local account mode or production login. |
| Final legitimate HTTPS origin | lists + pending-actions DB 20/20, zero skips | CI and local-account flags were explicitly absent; the origin was https://mikka.example.invalid. These suites call actual database writers, not account registration or a real public HTTPS service. Product authentication was unchanged. |
| Other related suites, unchanged product blobs | credentials 37+10; Gateway 9+48+9; incremental client 6, all pass with zero skips | Separate version-bound results; no claim that a single final 79-test command was rerun. |
| Final source types and lint | typecheck, lint/UI policy (55 migration-rule checks), diff-check all exit 0 | The final comparator change is test-only. |

The source/evidence transfer archive was 139737 bytes, SHA-256 `8a27fe1d9974469dd14e9c5aa910655f372f73da2e738ee8cf512f8e0e6ad2c8`. The raw manifests bind every command to its tree and timestamps. This document describes the final HTTPS rerun separately instead of treating the intermediate CI flag as local-mode authorization.

Each task-owned base database was checked for zero remaining connections, dropped normally, and independently confirmed absent. No force-drop, permission expansion, production Neon changes, shared-token revocation, external model request or production fixture was used by these commands.

## Scope and acceptance limit

The source replaces database-polling SSE with bounded authorized incremental reads and committed notifications. It does not change control/Stop authorization. C's event cursor and commit-order lock remain intact, as do broker isolation and fresh-session checks.

The original b127 UI and CI evidence stays historical. At 2026-11-05T01:19:27Z, exact-head GitHub checks were complete: 29 total, 24 success and 5 conditional skips, with zero pending or failing checks. All nine associated workflows completed successfully. Selected original GitHub metadata is retained under ci/. A second agent independently reviewed all 29 local and GitHub blobs and the integration; see independent-review.md. A new local production build/capture is still being collected separately. This packet establishes source integration and the stated local checks only.

The draft PR is not ready to merge: the issue body still requires a fixed real task for one hour before and after, matching Vercel route counts and PostHog/Neon traffic, then Web deploy, an exact public version pin and real production acceptance. None of those is inferred from these local fixtures.

