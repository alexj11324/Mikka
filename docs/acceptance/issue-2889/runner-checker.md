# Runner/checker rehearsal: PR acceptance gate

Issue: [#2889](https://github.com/alexj11324/Mikka/issues/2889)

Small change under acceptance: [PR #2964](https://github.com/alexj11324/Mikka/pull/2964),
the deterministic acceptance declaration gate for #2888.

Runner: `acceptance_gate` agent. Checker: separate root agent. Both roles use
the shared Cloud Linux workspace; the checker reviews plans, source, and
readbacks without operating the runner's acceptance command.

## Scope plan and first review

The runner proposed the following checks against the actual declaration CLI
and GitHub adapter. The initial plan used source
`7a43aca406d32878b2afd4af671588d38ff3761b`. The same scope now covers
`24ca0d414d8405a3d8d31f8603b30507f6aa1c6a`, which adds negative controls and
closes the metadata-read and example-declaration gaps.

| ID | Operation | Expected observation | Runtime | requiredEvidence |
| --- | --- | --- | --- | --- |
| A1 | Inspect missing, placeholder, UI, reasoned-exemption, and complete declarations | Closed errors for incomplete declarations; valid declarations pass | Neither device nor E2B: CI metadata tooling | Tested source, exact Node command, all test outcomes, exit code |
| A2 | On #2964, publish after removing Acceptance, then after restoring the correct declaration | Actual GitHub failure + missing label, then success + removed label, bound to the same current head | GitHub metadata API | PR number/head, UTC interval, CLI output/exit codes, status IDs and label readbacks for both phases |
| A3 | Exercise pagination, body edits, head replacement, API errors, draft state, and read-only operation | All files participate; no stale success; drafts stay pending; read-only writes nothing | Real loopback HTTP server and CLI adapter | Source, HTTP test outcomes, exact head/status assertions, command exit code |

The checker recorded `scope: accepted` and required two actual GitHub readbacks
for A2. It specifically requested a negative control showing that a previous
head's success cannot count for a new head. A loopback fake is not accepted as
the real GitHub demonstration.

## Execution plan and second review

1. Run the declaration and actual loopback HTTP contracts; reuse the unaffected
   full sibling-suite result through its earlier source/PR association. Add the
   requested old-head and mid-check-head negative controls.
2. Keep the current #2964 body, wait for actual latest-head CI results, and mark
   it ready. Remove only the Acceptance declaration, invoke the exact publisher,
   and read its current-head status and issue labels from GitHub.
3. Restore the declaration with actual evidence, invoke the same publisher,
   read status and labels again, and preserve the final corrected body.
4. Hand the plans, raw commands, source, and observations to the checker without
   supplying its verdict. The checker operates no acceptance command.

Commands:

```sh
node --test scripts/ci/pr-acceptance-check.test.mjs scripts/ci/pr-acceptance-github.test.mjs
node_modules/.bin/oxlint --deny-warnings scripts/ci/pr-acceptance-check.mjs scripts/ci/pr-acceptance-check.test.mjs scripts/ci/pr-acceptance-github.mjs scripts/ci/pr-acceptance-github.test.mjs
node scripts/ci/pr-acceptance-github.mjs --repo alexj11324/Mikka --pr 2964 --publish
```

The checker recorded `execution plan: accepted`, approved #2964 itself for the
authorized metadata rehearsal, and required the original body to be retained
and restored. The publisher receives its existing credential only in process
memory; it does not put a credential in argv, a file, or the evidence.

## Evidence available

The focused Node contracts at
`24ca0d414d8405a3d8d31f8603b30507f6aa1c6a` completed with **32 tests, 32 passed,
0 failed, 0 cancelled, 0 skipped** and exit 0. Focused oxlint with
`--deny-warnings` and `git diff --check` exited 0. The same contracts were rerun
from the stacked documentation head
`b4cb0da3187e5cf24c1e0935a8553550e32965a9` with 32/32 and exit 0;
[the raw output](contracts-b4cb0da31.txt) is retained here. No model or database
was used by these contracts.

Documentation checks at that stacked source plus the ownership clarification
found all 21 local Markdown links present, valid acceptance skill frontmatter,
and a Codex symlink resolving to the same Claude skill. These checks establish
document wiring; they do not establish the project runtime commands.

## Remaining evidence and checker verdict

A2 has not run yet. Latest-head CI and the final independent evidence verdict
are still pending. A1/A3 have runner evidence above; they are not marked with
an independent final verdict here yet. This report currently does **not** claim
the #2889 rehearsal or product device/E2B/UI acceptance is complete.

The final update must append the real status/label receipts and the checker's
per-row `pass`, `fail`, or `uncertain` decisions. Any missing required evidence
remains `uncertain` under [PROCESS.md](../../../.agents/acceptance/PROCESS.md).
