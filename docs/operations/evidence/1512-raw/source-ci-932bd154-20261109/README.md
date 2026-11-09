# Checkpoint 35 — published 932 source and retained partial CI

The feature branch was normally advanced to `932bd1549942bc2a8d040c7281a37fbe851c8eb0` at 14:42:10 UTC. Its tree is `3c0cc8bb828788e5817fc62048e46fe978e88dd5`; GitHub's actual PR checkout `86f8f6c1d05719db00de89f2ec3c4adf3b4d4fb3` has that same tree and ordered parents main765/feature932. The preflight proof is intentionally historical and records CI not yet started before the source update. The follow-up receipt records the subsequent natural CI.

Changes, Core and Source original logs are uniquely collected and retain full execution. The driver matches 74 exact passing cases in the combined Core command, while Source independently has 361 passed cases. A selection count is never treated as an execution count.

Integration job129229145015 actually failed: its unchanged team-import child hit a15-second deadline before printing its final report. That original failure and the distinct historical successful job129176683635 are both retained. Their Node/image match; source review and independent timing pairs support an environmental/cold-import slowdown hypothesis. They do not prove the stopped phase or CPU throttling. Historical native transport/SQL zero counters are not assigned to the failed child. A single bounded repeat of only the failed job is planned after the original Native window ends, without changing source, commands, deadlines or assertions. No repeat has started in this checkpoint.

The metadata is explicitly intermediate: 14 workflows and45 jobs, with33 success,1 failure,10 skipped and1 running Native as of15:01:47 UTC. Initial check associations predate three later jobs and are not final completeness proof. Native full-window/FIRST budgets and cleanup are pending. Production accepted cases remain0. No main change or production/model operation is claimed.

The separate upstream1810 proof is a frozen conditional source review of5c705587; that upstream source is not part of932. V8 verification helpers are preserved as reproducible data. All raw-log acquisition ownership and finite privacy-check limitations remain in the individual receipts.
