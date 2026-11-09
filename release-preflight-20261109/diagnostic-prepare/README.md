# Fresh H preparation — UNACTIVATED draft

This package neither creates a scope nor activates a workflow. All application/current-main/tree,
helper hash, runtime run/attempt/source and time pins are unfilled; the workflow has job if:false.
The intended ref is ops/1505-diagnostic-prepare-r7-20261109 and GO is
root-reviewed-1505-diagnostic-prepare-r7-v1. Existing OIDC subject authorization for that exact
ref must be established from actual identity configuration before activation. Do not change
the identity, roles or authorization subjects to make this draft run.

## Actual sequence

1. Bind real application A/current main, its tree, and independent upstream runtime R/run/attempt.
   This round normally A=R: the R7 publish/deploy job has already performed the first same-A Web
   build/pull/upload and verified READY/public. All seven R7 jobs must already be success before
   activating H; this workflow never waits or polls for them.
2. H verifies current main A and the existing public /api/version build A, verifies the original
   existing Bot is idle, restores the workspace/signs out, then attempts at most one fresh
   encrypted production-scope POST with 120-minute TTL. No renew/remove/upsert/retry is invoked.
3. Preserve the exact resulting fresh receipt and prepare independent exact cleanup before
   the second same-A Web deployment with overlay-refresh=true. That deployment's actual pull
   must capture fresh H; its DPL differs although source remains A.
4. Formal execution uses the published worker/templates and actual Web deployment receipt.
   The old original Bot receipt proves Bot identity only. It never supplies a current scope.

## Files and exact allowed change

The materializer reads exact 5958dea38437de20512bbbdf60b940ccc83f00ff sources from Git objects.
Original helper bytes: 27063; SHA256
46d8b905518cf480fecdf0a3bce1a3863f4e79c92609b1cd3ec9d4231820898c.
Original Bot receipt SHA256:
12f6f3758c382dd55c9055b3ab32f9d785c620594c66ad4d49a2030b3ccda8d5.

Helper changes are exactly the six exported SOURCE/TREE/BRANCH/HELPER_PARENT/
HELPER_PARENT_TREE/GO constants, plus this single additional check after the existing
application_version_invalid check:
check(version.build === SOURCE, 'application_version_mismatch')
Every other byte of the original helper is preserved. Original renewal and CLI code remain
inert: the new inline caller imports prepareWindow/readOriginalBot and calls prepareWindow
only. The original receipt file is byte-exact. The new caller is embedded in the workflow.

Final activated overlay must be a normal sole-parent commit whose parent is actual current
main A; diff must consist of exactly three added 100644 regular files:
.github/workflows/issue1505-diagnostic-window.yml
scripts/ops/issue1505-diagnostic-window.mjs
scripts/ops/issue1505-diagnostic-window-original-42366750743.json
The draft .in extensions, README, materializer and manifest are not part of that overlay.

## Activation pins and checks

- EXPECTED_APP_SOURCE/SOURCE and EXPECTED_APP_TREE/TREE: exact actual application A and tree.
- HELPER_PARENT=A and HELPER_PARENT_TREE=tree(A); helper BRANCH exact intended ref above.
- GO exact value above. HELPER_SHA256: compute from the final fully bound helper bytes.
- UPSTREAM_RUNTIME_SOURCE, UPSTREAM_RUN_ID, UPSTREAM_ATTEMPT: actual successful R7 source,
  current attempt and run. Finite run -> attempt-specific 7 jobs -> final run readback; all
  exact named jobs must be completed/success; no skipped/failure/old attempt accepted.
- NOT_BEFORE/ENTRY_DEADLINE/HARD_DEADLINE: strict UTC second precision, explicit new window.
  Draft enforces notBefore < entryDeadline, hard-entry >= 10 minutes, and total window
  <= 15 minutes. Job has a 10-minute cap; no remote business requests after hard deadline.
- Actual final helper/workflow/original receipt bytes, Git blob/tree/parent SHA and clean
  worktrees must be independently rechecked after binding. Never reuse these unbound hashes.
- Node24.22.1 native import-check runs before OIDC. Actual4c driver closure was imported
  successfully by root without any business call. No tsx/pnpm installation is required.
  Revalidate if actual A changes the import closure.
- The exact branch's existing Actions OIDC trust must be verified before creating any ref.
  Only prod:/ SMOKE_OWNER_EMAIL/PASSWORD and prod:/platform VERCEL_TEAM_TOKEN are read.
- Both production-smoke-owner-acceptance and web-deploy-production queues are retained;
  cancel-in-progress:false, queue:max; no child workflow dispatch or wait is performed.

## Recovery and actual boundaries

prepareWindow writes checkpoint receipts before/after the unique create boundary. The caller
keeps the latest actual report and uploads it with always(), including uncertain writes.
Post-main guard failure changes the final status to failed while preserving created window
ID/valueSHA/expiry and all earlier report data; it never means no scope was created.
Never automatically repeat preparation after failed/uncertain creation. Exact cleanup must
bind the actual fresh report, helper code/source/tree/run/attempt, scope ID/valueSHA/expiry
and original requester/workspace/Bot constraints. Do not substitute a historical scope.

Job cancellation, disk failure or an upload/network outage can prevent artifact delivery
despite always(); retain immutable helper ref and run identity and recover conservatively.
The draft does not claim cleanup occurred. It does not revoke immutable deployments.
Normal restore/signout are the existing helper's unchanged behavior; a hard network cutoff
can make those attempts fail, which remains a failed receipt rather than an invented success.

This is an offline draft, not a tested activated execution or production acceptance.
Root must review the complete generated workflow and syntax-check offline before activation.
