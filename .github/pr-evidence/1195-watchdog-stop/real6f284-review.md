# Real local recovery run 6f284: item 9 passed; item 10 failed before the server window

## Fixed version and execution

- Application and native daemon source: `020b3957e8fc9609528c69499609adef08150cdf`; tree `934e0d6c169d3ba43f269eed01f93e08dbe89eb4`.
- Temporary dispatcher source: `9703dba315192dede44d08ecc8aeb6bfbc95a23f`.
- [Workflow 41770132476](https://github.com/alexj11324/Mikka/actions/runs/41770132476), job `126377623661`; one submitted Vercel command `cmd_11d74271940c4e05a3d07bec82a2`.
- Driver run `6f284f6a-1dcc-4727-a61d-f6cb32c3426f`; isolated database `mikka_loop_6f284f6a1dcc_e2e`; loopback origin `http://localhost:3114`.
- Real permitted `deepseek-flash`, ordinary TestAccountPool login, two independently approved local daemons. GitHub remote/merge behavior is an isolated bare-Git fixture, not production GitHub. This is not an official subscription or Cloud-to-device acceptance.
- The application/daemon source was fixed during the run. The wrapper checked it again before writing the final dispatch result. Failed acceptance did not produce the success-only `source-evidence.json` or `passed-items.json`; these were not reconstructed.

## Item 9 passed

The offline local A-to-B recovery completed at **2026-11-04 04:04:58.814 UTC**. Task `9ff4586f-0258-44e5-9391-9b93d8f7baf8` retained request epoch `45d6719f-5e7e-48bf-aee3-c9fc16b392b0`. A run `8436f1f3-a7ab-423b-865f-028db2bcdcc0` was replaced by the one B retry `0e84121e-d478-427f-88f2-23ac8633b4b8`.

The final file has **45 bytes**, SHA-256 `621a2326909457fdc596e723cfd821266d43084da2f6c905efed024d9ee354f4`, commit `981052f1e28442f8894eee73a401a26dc2d910bd`. The report records one publication, one pull request, and one retry; normal review/verify and the fixture's real Git merge completed. The accompanying report preserves current-epoch handoff and actual Git evidence. Native session IDs are hashed.

## Item 10 failed; no watchdog success is claimed

Native-only suspension began at **04:06:32.113 UTC**, after the last progress/checkpoint at **04:06:24.994 UTC**. The unchanged 45-minute server threshold was therefore **04:51:24.994 UTC**. The report retained 33 successful heartbeat/lease samples; its last quiet duration was 1,964,087ms. Maximum recorded heartbeat age was 16,939ms and minimum lease remaining was 73,075ms.

At **04:40:05.639 UTC**, PostgreSQL canceled the driver's observation SELECT with `57014` under its existing 10-second statement timeout. Item 10 failed before the 45-minute boundary; its error is not reclassified as a watchdog stop. The whole wrapper exited **1** at **04:41:24.398 UTC**, `interrupted:false`, far earlier than its 85/88/90-minute wrapper limits. There is no complete fixed-source acceptance success manifest.

The retained query later completed in 0.677ms (81 cache hits, zero disk reads; 36 chunks for this run). Historical wait/lock observations were not recorded, so no specific historical contention cause is asserted. The separate query-diagnosis file records the original statement structure, hash, surrounding PG events, and read-only plan.

## Cleanup and limits

Only owned processes and four daemon credential files were cleaned; failure reports and the private isolated database were retained. At **04:53:56 UTC**, no owned process or listening port3114/3191 remained. Two owner device-token records in the retained DB are still unrevoked. The expired test-account lease prevents normal stale-authority cleanup; no SQL state or lease was forged to report success. This limitation is explicit in the cleanup record.

The follow-up observer change `55840a4f186c86b5c776629a8d075d654dd5c16f` records one read timeout and permits one fresh SELECT, while preserving all original epoch/heartbeat/lease/progress assertions and all product thresholds. It does not change this failed result. Any later case10-only run has a distinct fixed source, driver run, and database.

## Review

This record was assembled from the original item reports, final dispatch result, exact PostgreSQL error log and read-only retained-DB queries. No additional prompt, approval, cron, or recovery invocation was used to produce this evidence. Treat item 9 as passed within its local fixture scope, item 10 as failed/incomplete, and the combined run as failed.
