# Test ownership and CI cost

Use this guide when adding, changing or removing tests, or reducing CI overhead.
Dependency selection and protected checks remain governed by
[dependency-aware CI](incremental.md) and the
[workflow reference](../../.github/workflows/README.md).

## Review a new regression

Every new test needs an observable production contract, a realistic regression
that makes the assertion fail, a primary owner at the strongest practical
boundary, and an explanation of why existing tests do not cover it. Extra
layers must prove a different transport or lifecycle risk, not replay the same
mocked collaborator. Fixed independent expectations are stronger than results
derived from the code under test.

Avoid implementation-dependent call-shape assertions, vacuous negative cases,
source greps mistaken for behavior, fake receipts or mock implementations of
the outcome being asserted. Prefer failing-before-fix and passing-after-fix
evidence; a refactor preserving behavior should not make regression tests red.

## Audit a subsystem safely

1. Pin a main SHA. Record test declarations, owners, CI routing, original
   pass/fail evidence and the production entry points and callers.
2. Classify each case: retain, repair its assertion, consolidate into an
   independently verified stronger owner, or delete with explicit surviving
   proof. Assign every behavior a primary owner.
3. Inspect actual assertions and false-positive risks. Do not delete tests
   merely because they are slow, flaky, static or failing; baseline failures
   can reveal product defects.
4. Remove test-only production hooks only after confirming they have no runtime
   caller. Preserve authorization, tenant, storage, platform, SDK, schema,
   protocol, config, release and security proof.
5. Run retained owners and sibling tests. For moved coverage, introduce a
   controlled production mutation to verify the new owner turns red, then
   restore the original source. Review lost proof independently.
6. Report test/support LOC, production LOC, remaining contracts, actual
   execution cost, gaps, rollback and the latest tested source revision.

Never weaken DB inventory, required status checks, release-source binding,
credential handling or subscription acceptance to improve a benchmark.
Do not change shared fixtures while other tests execute.

## Measure before choosing faster infrastructure

The existing one-shot collector gathers completed-run queue, execution and
step durations without adding an Actions polling loop:

```sh
CI_TIMINGS_FILE=/tmp/ci-timings.json node scripts/ci/timings.mjs RUN_ID_1 RUN_ID_2
```

Compare equivalent PR scopes and distinguish job queue delay, dependency
setup/cache transfer, actual test runtime, wall time and runner-minutes.
Report cold and warm caches separately and mark cancelled runs as unproven.
Reduce workflow fan-out and obsolete PR attempts before buying more runners.
Benchmark faster lint/type-check executables only when the previous semantic
coverage remains intact. Blanket test-isolation disablement is not acceptable.

## Draft PRs and proof

Required merge checks never skip work merely because a PR is a draft:
GitHub treats a conditionally skipped required job as successful. The
independent specialized PR HTTP/CLI, E2B, search, SSH and unattended sandbox
checks may postpone runner allocation while drafting. Each retained workflow
responds to `ready_for_review` and reruns real selected proof on the current
head, including when no new commit was pushed. Production pushes, merge-group
checks and manual recovery remain authoritative. Keep Mobile OTA previews
available for draft UI evidence.

## Merge bar

Required checks remain authoritative on the exact PR merge candidate.
Unexpected skipped, failed and cancelled required checks are not success.
Exact-main postmerge and production publication must never be cancelled by PR
deduplication. Record actual measured changes rather than projected savings.
