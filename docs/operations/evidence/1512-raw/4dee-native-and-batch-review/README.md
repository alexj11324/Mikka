# Issue #1512 — 4dee Native originals, API diagnostics, and batch source review

This immutable evidence set preserves a failed query-budget result as well as successful checks. It is not production acceptance and it does not close issue #1512.

## Actual Native result

Desktop workflow **42399391047**, attempt 1, ran the actual checkout `817480a70ada3b66fca2cf55e9cf7b0d5e2d350a`, tree `b907cf48fc48c82351fe2e141970fbf77bc12ed8`. That tree equals candidate `4dee10cc9fc4e29dd5859ae49bb3a8ea51d9b431`. All four workflow jobs succeeded. The original query windows nevertheless **fail** the issue's Native <= Web requirement:

| Whole original window | Native | Comparator | Difference | Budget |
| --- | ---: | ---: | ---: | --- |
| Login | 210 | 209, actual Chromium Web | +1 | Failed |
| First startup | 184 | 132, hosted Web renderer in Electron | +52 | Failed |

The startup comparator is not an independent Chromium browser. No background, authentication, PKCE, RPC, or unfinished request was subtracted from either total. No window was shortened or selected after observing the result. All original JSON bytes are retained. `status=complete` describes the availability of the measured window, not compliance with the query budget.

Root independently recomputed all 12 cumulative snapshots, 8 segments and 4 whole-window totals from the original lifecycle JSON. Every one of the 24 rows conserves the 17 operation counters and the 75 unattributed-source counters. Segment and endpoint differences, segment sums, process/epoch identity, monotonic cumulative counters and zero unknown readings all matched. The independent recomputation is in `evidence/desktop-4dee10/root-counter-recomputation.json`.

Login has no crossed/unmatched request boundaries. Startup has one Native and four hosted requests completing after their respective window. These boundaries restrict causal attribution; they do not make either failed total pass. The raw action/source projections and closed integration analysis preserve the six extra Native logical starts and the window-crossing evidence.

Lifecycle 8/8, parity 100/100, smoke 10/10 and the three crypto processes passed. All recorded cleanup stages passed; the acceptance lease was released, and owner/peer after-baselines were present. An absent aggregate cleanup field remains unknown. These are not a provider-wide resource inventory. The artifact-recovery sandbox was explicitly stopped.

## API process failure and bounded diagnostic

The original 4dee CI and batch 01004 both failed at the alias test file after its first case passed. A single Go deadlock line does not establish the primary cause. The ordinary reporter did not expose the historical child exit code or signal.

The independent diagnostic workflow **42401735369** used the fixed failed checkout, exact Node 24.22.2 and pnpm 10.34.3, both original API groups, unchanged assertions, concurrency, test list and timeouts. It passed 77 + 53 tests; all three alias cases, including the actual LocalBuilder case, passed. It restored the temporary source/package changes and closed its launcher. It did not reproduce or explain the previous failures.

The diagnostic produced **zero phase records** and unavailable cgroup observations. Neither may be reconstructed from success or treated as zero OOM events. A pure projector check identified a diagnostic-only gap: the reporter accepted the absolute alias path, but discarded the same event with the exact relative alias path. The actual discarded event was not retained; no missing phase has been backfilled. No additional diagnostic run was launched to obtain a pass.

The batch's subsequent 5ded Source job used the standard TAP reporter and passed 84 + 58 tests, including the three actual alias cases. The fixed-source diagnostic and batch are different checkouts with different total test counts. Neither proves that the intermittent failure's cause was repaired. Final 5ded metadata records 17 workflows: 13 success and 4 cancelled. Its real Native step was skipped, so no paired Native budget exists for that revision. The cancellation cause is unknown. Batch replacement requires fresh full-workflow and Native evidence.

The diagnostic originals, both versions of the readback receipt, the preparation receipt and all four temporary diagnostic source files are preserved separately. The older readback remains historical; the newer version adds the observer-coverage limitation.

## Unpublished merge reference and unified batch

PR #1518 was merged into the coordinated source batch, not main. PR #1615 is the sole main-entry batch. The independently prepared 4dee + main0c12 source is retained here **only as an unpublished review reference**; no tree, candidate commit, source ref or competing main PR was published from it.

The reference includes the 94-entry merge plan, 13 resolved/generated source texts, preserved executable modes, and the source review. Its generated route JSON/TypeScript were reproduced from the existing rendering formula; the actual TypeScript generator and full product tests were not executed in that isolated review.

The read-only audit of batch 01004/5ded compared this reference with the batch and reviewed tracing, shutdown and preloader changes. It found no concrete #1512 merge regression in those checked files. This is source evidence, not proof that a production daemon exported spans or that query budgets passed. The next batch's actual source and deployment must be bound again.

The historical main687 cloud-core receipt preserves its own actual flags-contract failure. A separate, actual main0c12 receipt also records core_features/flags at the capabilities predicate. Its closed report does not reveal which individual condition failed. Enrollment, credential exchange and registration counters were zero; downstream gateway checks were not executed. Neither receipt proves a gateway failure or replaces the #1512 ACME acceptance.

## Integrity and boundaries

`index.json` lists each file's exact UTF-8 byte count, SHA-256 and Git blob SHA. Existing immutable originals were read back before inclusion. The archive commit is based on the previous evidence commit and also retains the latest owned operations commit as a parent; it does not alter a production branch.

A narrow secret-pattern scan and an email scan of non-source payloads found no matches. Those scans are supplementary checks, not a universal secrecy proof. Closed-schema readers and allowlisted artifact members excluded raw mixed job logs, screenshots/DMGs/ZIPs, environment values, user-message payloads, runtime SQL payloads and signed download URLs. Static source and test fixtures remain source code.

**Still pending:** final batch CI and real Native budgets, same-source production Web/E2B publication and cleanup, ACME production browser/Claude and separate Codex acceptance, actual same-trace stages and every generation, numeric usage/cost provenance, native Logs, masked Replay playback, timeline/scout verification, deliberate-failure retention, measured overhead and owned-resource cleanup. Issue #1512 stays open until those requirements are satisfied.
