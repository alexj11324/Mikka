# #210 current candidate isolated acceptance

Source **1b39b709ce361b9643524aea983860e6de818ff6**, Draft PR #259, frozen prerequisite #257 **20e2f2e4ed14a9b08b3ef02fb56199809e29558e**. This directory is the current candidate evidence. Root953, review-88eff86 and review-7095488 are retained historical evidence and are not silently relabelled as current.

## Two P2 review corrections and actual PG evidence

- `audit-deadlock-before-exact.json` / `.log`: copied isolated test harness against **exact9532817 product/SQL**. Advisory gates place stop after acquiring tenant audit H and complete after coordinator C, then release. Real PG reports **40P01** for stop; its rolled-back action is explicitly retried. This is an actual database reproduction, not the original reviewer's static lock model.
- `audit-deadlock-after-exact.json`: **current1b39b70**, same gates. Complete waits behind stop at the ordered mailbox locks before audit H; **both transactions fulfill**. No audit errors are swallowed or events skipped.
- `postgres.log`: current SHA **12 passed/0failed/0skipped**, including ordinary mailbox continuesRunId inheritance and owner/issue/mailbox/workspace/forged-parent negatives. Both retryOf and continuesRunId inherit validated parent scope. A continuation omitted from workspace audit was an attribution/visibility bug, not a demonstrated cross-tenant leak.
- `continuation-http.json` and raw `continuation-export.jsonl`: **11 actual compiled Next HTTP observations**: synthetic signup, foreign policy403, forged extra lineage input400, owner policy schedules an ordinary child, authenticated worker claim200/complete204, workspace query200/export200 include that actual child, foreign query403. Not a substituted retryOf-only fixture.

## Exact current runtime and request accounting

Compiled Next16.1.6/Node24 at loopback http://127.0.0.1:3110/mikka. Two distinct disposable PG17 databases **audit_app_1b_e2e** / **audit_workspace_1b_e2e**, no real provider/model key. `process.json` binds container label/image/start/buildID to source SHA. `migrations.log` applies all59 tracked SQL files across those targets; repeat log empty means zero pending files. `database-readback.json` shows actual ledgers, persistent stores, heads and continuation scope/status. No production/Preview database or real grant was accessed.

- `typecheck.log`, `lint.log`, `production-build.log`: passed. `postgres.log`:12/12. Actual final credential fixture:18/18, detailed below. Current CI additionally runs Factory/mailbox/Skill/BYOS/dispatch and browser cases; see ci-summary.json for the completed run.
- `acceptance.json`/`http.log`: **24** recorded actual auth/audit/export/permission HTTP observations.
- `worker-acceptance.json`/`worker-http.log`: **5** actual synthetic device claim/duplicate/complete/duplicate-complete/revoked-token observations; one claim audit and non-secret actor credential recordID. No real daemon/CLI/provider invocation.
- `failure-restart-acceptance.json`/`failure-http.log`: **11** actual HTTP observations: unavailable audit writer returns503 with no policy mutation/new session; recovery verifies. Compiled Next restart midway through a3-event export preserves count/digest. Controlled hash corruption409, restored chain200.
- The continuation11 above gives **51 primary HTTP observations (24+5+11+11)**, not51 independent tests or all server network traffic. The recorded continuation repeats11 requests on separate synthetic fixtures; health/navigation requests are not counted as independent cases.
- `base-head-check-comparison.json`: frozen20e,953,88eff,709 and current1b39 all stop broad pnpm check at the **same3 pre-existing frontend source/static-regex assertions**,54tests51passed3failed. The affected test/source/lock blobs remain identical. Broad check is not claimed green. No frontend layout/assertion change.

## Actual fixture defect fixed; failed and cancelled CI retained

Prior7095488 CI40218177477 attempt1 failed in the unchanged credential fixture: a controlled Chromium scenario took60.013s; subsequent3 owned-browser admissions returned credential_not_found404 because the shared synthetic device had no worker heartbeat across the existing60s freshness window. Same original fixture/authority bytes on frozen20e and709; complete unmodified suites both pass18/18 in22.1s locally (`credential-original-*.log` / comparison), so those local passes do not pretend to reproduce the full CI failure.

`credential-base-expiry-repro.json`: actual frozen-base authority/broker and real PG minimal synthetic schema, explicit clock-state injection: fresh resolves, device61s old yields broker404, heartbeat restores fresh, expired run lease still denied. This is not a full Chromium rerun or an actual61s sleep.

`credential-heartbeat-regression.json`, patches and logs: the copied frozen-base fixture with only the61s age injection produces **the3 matching404 errors**,13pass5fail total including parent/later cleanup. Its old negative cleanup waited with open browser state and the test worker was manually terminated; not claimed a naturally completed green run. The fixed copy with the same injection passes18/18, and **actual final source with permanent age regression passes18/18** (`credential-heartbeat-fixed-source.log`). The11-line source fix (`credential-heartbeat-fix.patch`) refreshes only synthetic device.lastSeenAt and the existing90s lease between independent scenarios. It never resets enabled/status/stop/identity/membership/secret state. Within-scenario expiry/revocation checks remain; no production guard/timeout is relaxed.

I requested one709 same-SHA retry after full base/head local suites and quota CI passed, but it made no environment/code correction. Once proceeding with the known fixture correction, I cancelled **attempt2**; cancelled is not success or acceptance. Attempt1 failure remains. Replacement CI **40221512522 at1b39b70 attempt1 succeeded** with the actual code correction: credential18/18, performance5/5, browser86passed/1existing skip/0failed, retries0. All applicable non-skipped checks succeeded; ci-summary.json contains exact run links. No repeated-retry-until-green claim.

## Recording bytes, scope and playback

- `audit-http-raw.webm`: untouched **6.72s** original Playwright VP9 capture of actual query/personal/member-denied API response views. It is only API views, not full product/production acceptance.
- `recorded-continuation/continuation-live-raw.webm`: untouched **17.68s1280x800 VP9** original capture of a visibly labelled live **acceptance console**, showing safe method/path/status while real continuation HTTP requests execute, plus final asserted child ID. It is not product UI.
- `recorded-continuation/continuation-live-viewable.mp4`: full **17.68s H264 re-encoding**, **no cuts**, no overlays added by conversion. Easier to download/play, **not raw**. Source raw bytes stay preserved.
- `video-info.json` lists each exact size/hash/codec/duration. Both raw WebMs match their original page@ capture bytes. MP4 fully decodes; `native-video-playback.json` confirms a native Chromium element played beyond1s,1280x800,errornull. Public anonymous byte readback and public media check are supplemental metadata after upload. Hosting may return download content-types; no default inline-navigation claim.
- PNGs are original unedited screenshots. Media/receipts show only synthetic opaque fixture references and fixed safe codes, never auth cookies, bearer/password/email/provider payloads. Reproduction drivers generate synthetic secrets in memory and do not serialize them into evidence. Inspect checksums before review.

## Integration / release boundary

`migration-manifest.json`: only the2 new never-deployed increments, exact logical DB targets/bytes/hashes. `migration-rollout.md`:57 predecessor files, split/shared DB handling, partial commit/retry, Preview selector, controlled writer window, rollback retaining history. Old-app rollback alone can reintroduce old mailbox lock ordering while triggers remain. No production SQL or source history deletion was performed.

`policy-integration-contract.md`: #230/#231 same-transaction appendAudit/auditActor contract. Current v1 accepts bounded safe references/codes, not arbitrary inline policy/provider/model/region fields; an immutable tenant-authorized decision receipt may be referenced by resourceId, or coordinate a versioned extension to both DB validators/TS. No implicit provider/region JSONL coverage claim.

Local history: a hostname/self-proxy and native-binding setup issue in a supplementary Skill browser run was corrected without product layout/routing edits; complete709 Skill browser passed1/1. A later local root ENOSPC occurred after709 acceptance, preserved in that directory with19-stream recovery. Retaining logs then removing only this lane's exited disposable Node containers recovered space; no database volume/evidence was deleted. Current1b39 uses a fresh database pair and a fresh compiled process, not the interrupted process.

Keep #210 open and PR draft. Parent independent re-review of current SHA, unified integration/deployment, approved production SQL targets/window and actual production/user/OAuth/provider acceptance remain pending. Hash-chain detection is **not WORM** against a privileged whole-chain rewrite. No external checkpoint service, cleanup scheduler or legal/compliance certification is activated.
