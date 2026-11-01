# Browser CI in two levels

- Date: 2026-11-01
- Source: Alex, through the coordinator session on 2026-11-01: chose the
  "两级" (two-level) browser CI plan
- Rule: —
- Replaces: the pull request and main-push browser tiers in CONTRIBUTING.md,
  "How changes are tested"

Pull requests block only on a small browser smoke set: sign-up and sign-out,
Bot and Coordinator chat including saved OpenUI replies, the board, settings
sections and device authorization. The goal is 3 to 5 minutes.

Every push to main runs the whole browser suite after the merge, without
blocking it. A red main run opens or updates one issue labelled
`browser-regression` that lists the failed specs and the run.

No spec is deleted or skipped and no assertion is loosened; area specs, edited
specs and performance move from before the merge to after it.

Evidence behind it (sample of 47 failures over 4 days): 18 infrastructure, 10
outdated tests, 9 intermittent, 5 real bugs. A passing pull request run took a
median of 13 minutes and was the last check to finish on 75% of pull requests.
