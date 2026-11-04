# Real offline handoff: item 9 passed, overall run in progress

## Fixed source and scope

Workflow [41759046100](https://github.com/alexj11324/Mikka/actions/runs/41759046100), job 126342049054, runs application commit `3362fb03ef8d5f963d55b9eacc36a51d58ad0686` (tree `7d5da89896e9d1726301d0dca66c6af3b72e1cdc`). A read-only source observation at 2026-11-04T02:23:25.052595+00:00 confirmed this exact HEAD with no tracked changes. The driver run is `6655d16b-ce7e-44b7-8ef1-e9d6114f09e5`, using isolated database `mikka_loop_6655d16bce7e_e2e`.

**Item 9 passed at 2026-11-04T02:18:34.833Z. Overall acceptance remains in progress; item 10 is pending.** This is real DeepSeek Flash execution with two normally authorized local daemons, unchanged 90-second leases and normal minute cron, a disposable application database, a local GitHub fixture and actual bare Git commits. It is not production verification, real GitHub merging, Cloud-to-device runtime acceptance, or official Claude/Codex subscription acceptance.

## Actual recovery and acceptance

Task `6a267d61-6023-4315-8a2a-4a639d3e619b` retained request epoch `81bc9406-bbb3-4079-80c0-fa1e8408ab3d`. A `045b91a1-29fb-44e6-99c9-f8bd003fd697` was automatically selected without an explicit device pin. The driver captured a real checkpoint and suspended the owned daemon tree at 2026-11-04T02:13:30.725Z. B `e858ce9d-b031-439b-9a77-27c29eaad15f` was the unique retry of A on a different normally authorized device. Its native execution actually started, used the persisted host handoff, and completed. A was resumed and its old execution remained fenced.

Independent read-only PostgreSQL observations confirm that B's execute, independent review, verify, human approval and publish stages all passed in the same epoch. The Task is `publish/passed`; merge `397495b0-f3f3-4b6e-8f64-2693b028fada` is `merged`, with candidate/head SHA `9cb56d43df4c843e5238b7d3cb84676443c790e7` and actual merge commit `0781d93a5e80f6bb1f0c050da4734bc29fc4d7ee`.

The artifact `handoff-2e4b10aa-b397-4eb0-a5f7-40ee1e4b7cf1.txt` contains exactly 45 bytes. SHA256: `dcc826551c9932a1a67d6cc518c35857b07cfc3581858be79de0f7402430c155`. Independent Git reads confirmed the requested marker plus one newline in the candidate, identical bytes in the merge commit, and two actual merge parents. The local fixture URL `https://github.com/mikka-e2e/core-loop/pull/41` is synthetic, not a real GitHub PR.

The driver observed one extra normal minute schedule after acceptance: publications **1**, pull requests **1**, retries **1**, unchanged. Independent read-only publication and fixture reads also found one published record and one fixture PR. The previous real666 run remains failed; no prior result has been rewritten.

## Item 10 remains pending

The next scenario uses Task `0338f390-bb82-4173-a945-718db36de0a1`, epoch `4267cf96-3d95-403d-834e-d2722c2aefbe`, run `00a80708-dc92-40e0-b34c-712ba108bec8`. Its native process subtree was suspended at 2026-11-04T02:20:06.574Z; the daemon remained online. Last task progress was 2026-11-04T02:20:04.608Z. The recorded phase is `online-without-progress`. At the stored snapshot, quiet time was 129061 ms, maximum observed heartbeat age 15447 ms, and minimum remaining lease 74556 ms.

This dedicated test daemon uses the existing explicit `--stall-minutes 60` option to isolate the unchanged server's 45-minute execute watchdog; the ordinary daemon default is 10 minutes. The 30-minute checkpoint recovery window remains unchanged. The server watchdog cannot reach its 45-minute threshold before approximately 03:05:04.608Z, followed by a normal cron observation. No watchdog completion, recovery, controlled block or 45-minute runtime result is claimed here.

## Evidence and privacy

The companion JSON files record the sanitized original item 9 report, read-only Task/stage/merge projections, actual Git bytes and side-effect counts, and a timestamped item 10 start snapshot. Native session identifiers were replaced by recorded flags and SHA256. No credentials, cookies, private prompts, process environments or full process arguments were exported.

The manifest records original source-file SHA256 and Git blob identities for every companion file. Git API writes only add evidence to `evidence/proactive-1157-1163`, with a compare-and-swap branch update. No live source, database row, model, approval endpoint or cron was mutated during evidence collection.
