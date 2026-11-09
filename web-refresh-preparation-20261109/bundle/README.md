# One same-A Web overlay dispatch — UNACTIVATED

No scope, run, ref, account or production credential is created/read by this preparation package.
The workflow has if:false, all activation pins are null in pins.unfilled.json, and the receipt
template is null. No historical source, receipt, scope, run, artifact or time window is prefilled.
The only intended activated ref is ops/1505-web-overlay-refresh-20261109.
GO must be root-reviewed-1505-web-overlay-refresh-v1.

The active shared owner #1810 has its actual 16:22–17:52 UTC window on 2026-11-09.
This operator is for our subsequent actual segment only. Root binds a real later window after
that owner's work/handoff; this preparation does not occupy any shared queue or launch anything.

## Existing normal method and fixed source review

At 8c423db291f8121980267cd48a24e428c992f618, Web workflow blob is
bab7ed46eefd7bd4b6db712e8e141484be9f73ba.
At e189d7652fd2fce48b77a3697abf5bb177d8ebd1, it is
e15741a3ae51a294593eeb2151311378babd8ce4,
11619 bytes, SHA256 2916c80cc6a764fe2167ad5dad17be68b309161119bffbcb9001ee26b015e9a1.
The only workflow difference is removal of FFMPEG_GITHUB_TOKEN from dependency installation;
workflow_dispatch inputs, source fences, Web queue and actual pull/build/upload/public checks match.

Existing workflow_dispatch exposes boolean overlay-refresh with false default. True enters
RUNTIME_REFRESH at the skip helper and forces a same-source build. The ordinary downstream
job still checks main, reads its existing deployment secrets, pulls actual production env,
builds, uploads prebuilt output and verifies public source/overlay. This operator does not
set runtime-refresh, publish worker/template values or change any downstream guard.

The public main workflow inventory contains no standalone operator for this specific fresh-H
handoff. The documented private official-mikka.yml already uses normal overlay-refresh dispatch,
but its credential-reading entry is not needed here. Reuse the ordinary documented GitHub API.

Official primary sources:
https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event
https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow

The current documented API header is 2026-03-10. The single dispatch request is:
{"ref":"main","inputs":{"overlay-refresh":true},"return_run_details":true}
GITHUB_TOKEN workflow_dispatch is an explicit allowed downstream-trigger exception.
No OIDC, PAT, new identity or extra approval flow is introduced.

## Exact activated overlay

Use a normal sole-parent commit directly on actual current main A, with exactly two added
100644 regular files:
.github/workflows/issue1505-web-overlay-refresh.yml
scripts/ops/issue1505-fresh-h-web-refresh.json

No source/product file changes. The standalone operator.py, draft .in extensions, README,
pins and manifest are review artifacts and do not enter that overlay. Workflow embeds the same
operator.py bytes. GITHUB_SHA, push event after/ref, checkout HEAD, sole parent/tree and the
current operator ref must agree. Attempt must be 1. No re-run of an uncertain POST.

## Fill from actual A and the one fresh H read

- APP_SOURCE/APP_TREE: actual application A/current main and its tree.
- WEB_WORKFLOW_SHA256: exact downstream workflow bytes at that A. Re-review if different from
  the fixed reviewed workflow. Do not use old source values merely because they are documented.
- H_HEAD/H_BRANCH/H_RUN_ID/H_ATTEMPT: immutable successful creation run and its source branch.
  Closing H by a normal later commit is allowed; operator never checks current H branch head.
- H_ARTIFACT_ID/NAME/SIZE/SHA256: exact fresh artifact metadata and ZIP digest.
- H_RECEIPT_MEMBER/H_ORIGINAL_RECEIPT_SHA256: exact member path and bytes from Root's single
  authenticated ZIP read. Root validates ZIP/member inventory and pairing once.
- RECEIPT_SHA256: bytes of the exact safe copy committed for this operator. Normally identical
  to original member hash. If the original contains a secret, never commit it: Root must first
  make and record a safe projection preserving all required proof fields and its different hash.
  The operator verifies the copied bytes and immutable run/artifact metadata; it deliberately
  does not download or re-extract the ZIP. It does not independently prove the offline
  original-member-to-copy transformation.
- H_SCOPE_ID/VALUE_SHA256/EXPIRES_AT: exact fresh prepared scope. It must remain unexpired
  throughout the dispatch window. No old receipt, scope or previous renewal may substitute.
- NOT_BEFORE/ENTRY_DEADLINE/HARD_DEADLINE: new UTC window of at most 15 minutes.
  Job cap is 5 minutes; each network request is bounded by min(20s, remaining hard budget).
- DISPATCH_GO: exact value above. Remove if:false only after independent final bytes/tree review.

Preflight validates prepared status, A/tree/version, zero model/VM/profile creation, original
Bot idle/restore/logout success, one acknowledged and readback-verified 120-minute fresh scope.
H run -> artifact -> final H run checks are finite, read-only metadata. No polling and no
originals downloaded. Only this operator's own concurrency group is held; no Web or SMOKE lock.

## POST outcome and handoff

A fsynced checkpoint is saved before the unique POST. No redirects, retries, fallback POST,
child waiting or downstream polling occur. Post-response checkpoints preserve known acceptance
even when parsing, identity validation or the hard deadline later fails.

200 with exact official response fields records the child run ID and ends successfully.
204 is recorded as accepted_without_run_identity and ends nonzero: accepted, not rejected,
and never permission to repeat. Transport failure, 5xx, malformed response or unknown identity
also forbid automatic retry. Root uses immutable metadata to resolve the actual dispatch.

A successful dispatch is not READY, not a confirmed scope capture and not formal acceptance.
Root independently verifies returned run metadata: repo, workflow path, event=workflow_dispatch,
branch=main, source=A, run attempt, actor/time and expected build/pull/upload/public result.
A current-main GET and dispatch ref=main are not an atomic compare-and-swap. If main advances
in that gap, preserve the exact child identity and reject its use for A; do not guess or repeat.
Web's own main/source and deployment checks remain authoritative.

The receipt proves H creation, not its current Vercel presence or inclusion in a later DPL.
Root confirms actual Web pull/build/upload/READY and later formal diagnostics separately.
Cancellation, disk or artifact upload failure may prevent checkpoint delivery; preserve the
operator ref/run and assume an attempted POST may have created a child until metadata resolves it.

This is an unactivated draft. Offline materialization and syntax checks do not execute the
operator and are not production acceptance.
