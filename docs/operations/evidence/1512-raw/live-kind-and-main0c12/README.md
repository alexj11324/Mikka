# Issue #1512 — Live kind coverage correction and deployment readbacks

This evidence set binds a two-file Live correction to exact source and complete test output. It also preserves main0c12 publication, f753 final workflow metadata and read-only PostHog configuration verification. **It is not production acceptance.**

## Reproduced redundant read

A B read begins and commits after Live ready. Only an unrelated kind A then receives a push. A late B subscription previously used A's new global boundary and repeated B's read.

The correction keeps ready/presence coverage global and records ordinary push boundaries separately for the fixed 29 LiveKinds. A late subscription uses the newer applicable boundary. Close clears both; same-kind events, reconnect and reads beginning before connection coverage retain their refresh. The correction does not maintain a per-entity map and does not change UI, measurement windows, thresholds, database reads or polling.

The original product source plus the four new boundary cases returned **3 pass / 1 fail**, with two reads instead of one only for the unrelated-kind case. The corrected source plus the complete channel suite returned **59/59 pass, exit 0**, Node v24.22.1 in one deny-all sandbox. Production LiveChannel and read-observer code ran; React/SWR rendering, canonical TypeScript, full lint, database tests and Native acceptance did not run in that sandbox. The exact stdout, empty stderr, test-support source and no-index diffcheck result are retained. A no-index diffcheck exit 1 with empty output is not represented as a lint/typecheck exit 0.

Candidate `db988428a95a47637f04089ffc51aad37343c9dd` has parent `0d379dd92fd2d7b3f2b307030c3bcd8234426d0e`; its two original target blobs were byte-identical to tested base f753. Its only changes are channel.ts and channel.test.ts. This candidate did not modify the shared batch or main ref when created.

The prior 4dee budgets remain failed: login **210/209** and startup **184/132**. The regression proves a real possible redundant read; it does not assign all six historical additional logical reads to this cause or prove a subsequent Native budget. Current source, actual native binaries, harness and whole-window raw counters still require their own binding.

## Resource closure

The only regression sandbox, `sbx_gSDmXaj1VoZB347ZvAQGOFGpOVwf`, was actively stopped at **2026-11-07T19:02:14.539Z** and independently read back as stopped. It used one CPU, 2 GiB, no network or ports, and no production credentials. Runtime was 261,268 ms with 4,992 ms active CPU. No new environment was created to recover the 33-byte isolated package file; its original retained upload text was published and hash-checked.

## Separate release and configuration evidence

- Main0c12 E2B workflow 42399456431 finished success at 18:56:25 UTC, seven jobs successful. The separate receipt distinguishes each publication gate from the closed final cleanup scan: zero matching sandbox entries, zero cleanup errors, and three accepted public templates intentionally retained. It does not invent an earlier kill count or duplicate full candidate-report validation.
- The Vercel provider reported the same-source production deployment READY with the expected aliases. This provider metadata does not itself establish the public response body; the GitHub release receipt records its separate actual public-version check.
- f753 finished with 15 successful workflows, one CI failure and one cancelled Desktop workflow. Its Native acceptance step was skipped. This is not an all-green or measured-Native result.
- The two #1512 scouts were read back enabled/active with emit enabled and Inbox enabled, no Slack/webhook destination. Timeline C9vQAc1L remained version 15, unchanged SQL, blank IDs and stopped kernel. No scout run, cell execution, configuration write or compute start was initiated by that readback.

The main0c12 cloud-core flags-contract failure is preserved in the preceding evidence commit. E2B release success does not turn that separate failed gate into success.

## Integrity

The index lists exact byte lengths, SHA-256 and Git blob identifiers. All frozen inputs were fetched in full and checked before inclusion. Actual source is retained both as the candidate parent graph and as explicit regression files. The evidence ref advances without changing production refs.

No live credentials, private user messages, raw mixed application logs or signed download URLs are included. Static fixture UUIDs, gateway.test endpoints and synthetic presence tokens are test data. Production browser/Claude and separate Codex work, actual PostHog trace/generation/log/Replay verification and final resource cleanup remain pending; issue #1512 stays open.
