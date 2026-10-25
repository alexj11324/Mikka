# Review fixes and exact-SHA isolated acceptance

Source **70954888ecf6e13d88cab736060044f9f7dee832**, Draft PR #259, frozen prerequisite #257 **20e2f2e4ed14a9b08b3ef02fb56199809e29558e**. This directory supersedes the root9532817 and review-88eff86 acceptance as the current candidate. Original evidence is retained unchanged.

## Two P2 review findings

- `audit-deadlock-before-exact.json` / `.log`: actual PostgreSQL reproduction against exact original 9532817 product/SQL, with a copied isolated test harness. Explicit advisory barriers establish stop holding audit H and complete holding coordinator C; release yields **40P01** in stop. The failed transaction is explicitly retried, not hidden, and final rows retained.
- `audit-deadlock-after-exact.json`: exact current 7095488, same PG harness and gates. Mailbox locks precede audited mutations; complete waits behind stop before reaching H. Both transactions fulfill, with stop cancelled and complete stopped. `postgres.log` reports **12 passed, 0 skipped**, including real ordinary continuation scope and owner/issue/mailbox/workspace/forged parent boundaries.
- `continuation-http.json` / `continuation-export.jsonl`: **11 actual HTTP observations** through compiled Next: synthetic signup, foreign policy denied, forged policy input rejected, owner policy schedules a real `continuesRunId` child, actual worker claim/complete, workspace query and export contain that child, foreign query denied. This is ordinary mailbox continuation, not a substituted retryOf fixture.

## Actual current-SHA execution

Compiled Next 16.1.6 / Node24 with no model/provider key, at loopback http://127.0.0.1:3110/mikka. Application and workspace are two distinct disposable PG17 databases, named in `process.json`. No production/Preview DB or real provider credentials were accessed.

- `production-build.log`, `typecheck.log` (empty successful output), `lint.log`: passed. `migrations.log`: all59 tracked files across isolated targets; repeat log empty because no files pending.
- `factory.log`: **164 passed, 0 skipped**, including explicit enabled DB cases. `mailbox.log`: **29 passed**. `skill.log`: **27 passed**. These are suite counts, not HTTP observation counts.
- Main `acceptance.json`: **24** actual HTTP observations. `worker-acceptance.json`: **5** claim/duplicate/complete/revoked-token observations. `failure-restart-acceptance.json`: **11** storage unavailable/rollback/restart-mid-export/controlled-hash-corruption observations. Plus continuation **11** above = **51 primary HTTP observations**, not51 independent tests.
- Recorded continuation below repeats that11-request scenario on separate fresh synthetic fixtures. Do not count it as11 additional independent cases.
- `base-head-check-comparison.json` and three pnpm check summaries: same physical Linux/node24.19.0/pnpm10.34.3 installation, frozen20e, original953 and current88eff. All stop at the same3 pre-existing frontend source/static-regex assertions (54 tests,51passed,3failed). Compared test/source/lock blobs are identical at base/original head; final source has no frontend layout/assertion edits. Full private diagnostic logs are hashed, not dumped into public evidence.

## Recording scope, bytes and playback

- `audit-http-raw.webm`: original untouched Playwright capture of actual API query/personal/member-denied responses, 6.28s. It is **only API response views**, not a full product/production walkthrough.
- `recorded-continuation/continuation-live-raw.webm`: original untouched **17.68s 1280x800 VP9** Playwright capture of a visibly labelled **acceptance harness**, displaying safe method/path/status as each real continuation HTTP request completes. Includes real foreign/forged denial, scheduling, worker claim/complete, query/export, final asserted childID. This is an evidence console, not product UI. `reproduce.mjs` is the source driver plus recording hooks.
- `recorded-continuation/continuation-live-viewable.mp4`: complete **17.68s H264 format copy** for easier playback; re-encoded in full with **no cuts**, no added overlays during conversion. It is **not raw**.
- `video-info.json`: per-file codec/duration/bytes/SHA256. Both WebMs are byte-identical to their original Playwright `page@...webm` capture. MP4 fully decodes; `native-video-playback.json` confirms Chromium's native video element played beyond1s with1280x800,errornull. Public anonymous URL readback is recorded separately after upload. Raw WebM URLs may download due hosting content-type; that is not an inline-playback claim.
- PNGs are original unedited screenshots. All accounts/IDs are synthetic; no cookies, bearers, passwords, emails, provider payloads or actual user data appear in recordings/receipts. Drivers generate synthetic secrets in memory and never serialize them into evidence.

## Integration / production boundary

`migration-manifest.json` gives only the2 new never-deployed SQL increments, exact targets/bytes/hashes. `migration-rollout.md` documents existing57 migration prerequisites, split/shared DB behavior, partial-commit retry, preview target selection, writer window, and rollback risks. Old app rollback alone reintroduces the old mailbox lock ordering while triggers remain. No history was deleted or production SQL executed.

`policy-integration-contract.md` is the #230/#231 audit interface. Current v1 allows bounded nonsecret reference/code fields only; normalized policy/provider/model/region metadata must be bound to an immutable tenant-authorized decision receipt referenced by resourceId. It is not already inline JSONL metadata; adding those keys requires a coordinated versioned contract extension.

Keep #210 open and PR draft. Parent independent re-review of the new SHA, unified integration, production SQL authorization, deployment and actual production/user acceptance remain pending. Hash chaining is not WORM protection against a privileged whole-chain rewrite. Retention is explicit; no new scheduler or independent checkpoint service is activated.

## Current CI is not green; exact failures retained

Current7095488 run40218177477 failed before the application browser stage in the unchanged credential acceptance fixture: a controlled-browser subtest took60.013s, then3 owned-browser cases failed credential_not_found404. The fixture's device freshness cutoff is60s and the shared run lease90s. Parent coordinates a minimal shared synthetic-heartbeat fixture fix with the budget lane. No production guard is relaxed here and no blind rerun is substituted for diagnosis.

`credential-base-expiry-repro.json` / `.log` / `-reproduce.mjs`: actual frozen20e authority/broker, real isolated PG minimal synthetic schema. Explicit clock-state injection proves fresh resolve success → device61s old resolves null and broker.create404 → heartbeat restores admission → expired run lease still denied. This is **not** a full frozen-base Chromium suite rerun or an actual61-second wait. Acceptance test and authority blobs are byte-identical at20e/7095488. See `ci-failures.json`.

Earlier88eff86 run40216696886 reached application browser: performance5passed, browser85passed/1skip/1failed; single failure was the fixture modifying retryOf after insertion, now fixed by7095488 inserting lineage at birth. All original unadopted-retry409, zero-token/receipt, cancel/revoke and selection assertions remain. `skill-browser.log` records the entire Skill Playwright scenario passing on7095488 through compiled Next + separate local PG,1passed9.7s. This does not turn the failed overall CI green.

Local environmental history: an initial supplementary Skill browser attempt bound Next to127.0.0.1 while next-intl rewrote tolocalhost, causing a self-proxy redirect loop. A subsequent start lacked the native-binding cache. Correct loopback hostname plus existing native-binding cache fixed the harness configuration; no product layout/routing patch was made. Later the local32GB root filesystem reachedENOSPC after primary acceptance and recordings had passed, causing this lane's PG container to stop. Reproducible build/dependency caches were moved to tmpfs, retaining originals/data/evidence, PG restarted, and `enospc-recovery.json` verifies19 recovered audit streams. This is an unplanned isolated incident, not a production storage-fault exercise. The acceptance app containers were explicitly stopped during cache relocation; they are not claimed currently serving.
