# Real offline handoff acceptance: 66606464

## Result

**Overall: failed. Item 9 reached real recovery, publication and independent checks, then failed at the human acceptance API. Item 10 did not execute its online-stall scenario.** Its wrapper entered the item and immediately rejected the unmet item 9 prerequisite; no 45-minute observation occurred. This run must not be represented as a successful item 9/10 acceptance or as production / Cloud-to-device acceptance.

- Fixed application source: `f8cbd5456be4301946f73711370d0a15271502bb`.
- Driver run: `66606464-2183-4c2f-9a00-5ec983f6f513`.
- Isolated database: `mikka_loop_666064642183_e2e`.
- Task: `280ca225-3bdb-4e1f-a803-3e3fd0abe07d`.
- Current request epoch throughout: `3dfdbff2-e776-4670-92cf-843f3948f1a5`.
- Real model: the existing DeepSeek `deepseek-flash` alias, with normal account authorization. This does not establish a separately verified model version or official Claude/Codex subscription acceptance.
- Environment: two real authorized local daemons in the owned Vercel Sandbox, the unchanged 90-second lease and normal minute cron, a disposable application database, a local GitHub fixture and real bare Git publication.
- Dispatch result: `failed`, exit code `1`, `interrupted: false`, completed `2026-11-04T01:53:25.372Z`.

## Recorded execution

A (`99c6a649-4b4b-4478-8c4e-ef0df8c808a1`, device `153a1873-d86a-455b-a708-0026f20919aa`) started at `01:46:39.970Z`. The automatic placement was unpinned. A real checkpoint was captured at `01:47:07.277Z`; the owned daemon tree was suspended at `01:47:08.028Z`. The recorded lease expired at `01:48:36.678Z`.

The normal recovery path ended A at `01:49:00.177Z` with `failed/device_lost`, and its publication was `skipped`. B (`fcb498d0-f4fe-46c0-8da5-b5e5f63e2223`, device `e540419f-85b3-4bcc-9e6b-7012574ad3ff`) was the actual `retryOf=A`, started at `01:49:01.297Z`, and finished at `01:49:39.428Z` with `succeeded/submitted`. The persisted host handoff and checkpoint were checked by the driver, and its resumed-A fencing assertions completed before publication/acceptance checks.

B published exactly one `run_publications` record for this Task. The local fixture PR was `https://github.com/mikka-e2e/core-loop/pull/41`; this is a synthetic fixture URL, not evidence of a real GitHub PR. Its actual bare Git candidate was `fa4a10cb1f4e561d65dc108f92e5c4bb465ba971`. The artifact contained exactly **45 bytes**, matched the requested marker plus one newline, and had SHA256 `7d64e0a65652e156843765f8a06b7f2b2eb55c2b3a24a7d779200bea73b5fb21`.

The independent review run `596fa965-01c8-4fa7-84bb-f33c0cd1f96d` passed, then verify run `2050effe-3bab-4138-8c32-3e70ff3e2c3f` passed at `01:53:06.480Z`. All attempts retained the same request epoch. The Task reached `approval/pending`, revision `12`.

## Failure and bounded correction

At `01:53:16`, the normal owner `POST /api/factory/tasks/280ca225-3bdb-4e1f-a803-3e3fd0abe07d/approval` returned HTTP 409. The unique merge ledger record `4d9ee549-be2b-4974-a25e-aa28418fcf95` recorded **`githubUnavailable`**. It had already passed the current binding and human authorization gates. No stale binding or repository admission refusal was recorded.

The exact source fixture lacked `PUT /repos/mikka-e2e/core-loop/pulls/:number/merge`. An independent loopback reproduction with real bare Git and a real fixture PR returned HTTP 500 with `Unexpected GitHub operation: PUT /repos/mikka-e2e/core-loop/pulls/41/merge`, which the production merge API correctly maps to `githubUnavailable`. The failing fixture source and reproduction baseline had identical SHA256 `d9c83a70f9cd06dc7fa19a430b2fd661850c528e31dff3cbdff3e10d33e1a8e4`.

The separate fix commit `3ec6a54501a158ecbc1ecc45f303fce0ede7475a` implements the missing local fixture operation using an owner-only, candidate-SHA-bound real Git merge and compare-and-swap default-branch update. Its regression verifies actual commit parents and artifact bytes, identity/SHA refusals without ref changes, and replay without a second merge. The fixture suite passed `10/10`, zero skips, and root plus Group independently reviewed the fix. This follow-up does not alter this run's failed result or bypass production gates.

## Evidence provenance and cleanup

The JSON companions contain the sanitized original item 9 report, original dispatch result, selected original progress records, and read-only PG stage/execution projections. `real66606464-source-records.json` records source file hashes and selected progress-line hashes. Native execution session identifiers were replaced by a presence flag and SHA256; authentication files, cookies, API keys, credentials, full prompts, process arguments and process environments were not exported. No approval retry, private sweep, cron invocation or model call was made during this investigation.

At `2026-11-04T02:09:36.925402Z`, the prelaunch cleanup check found old wrapper PID `34423`, application parent PID `34528`, and A daemon PID `35396` absent. No process command line or working directory matched the exact old owned acceptance directory; only process metadata would have been exported. Port `127.0.0.1:3112` was not listening. This is a timestamped check of the old run, not a claim about services started later. No process was killed or resumed by the evidence-export operation.

No passed-items or fixed-source success manifest has been created for this failed run.
