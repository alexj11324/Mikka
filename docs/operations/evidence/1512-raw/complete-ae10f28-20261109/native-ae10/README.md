# Native evidence for ae10 / CI 42603781956

This folder preserves one natural Native execution, job 129117574595, completed successfully at 2026-11-09T11:14:49Z. The Native job's own checkout, build output and original JSON identify ddbc7e9b8e156493af730f00ed4a6efd3de475b4, tree 1acbe0b8d50a7102543e24b9bd0395355bcba438, exactly the candidate tree of ae10f28aa471dbfc64f04d981b8934d374476259.

## Original query budgets

| Original measured window | Native | Same-source Web / hosted | Result |
| --- | ---: | ---: | --- |
| Full login including email authentication, PKCE and concurrent background | 429 = 19 + 13 + 397 | 435 = 19 + 0 + 416 | 429 <= 435 |
| Original first startup pair (pair 1) | 197 | 230 | 197 <= 230 |

No requests were subtracted, no later startup pair was substituted, and no CI rerun was requested. The 24 records, 12 checkpoints, 8 segments, 17 operation buckets and 78 source buckets reconcile. All 1291 projected query ordinals in the four measured windows reconcile with the original scopes and bucket counts.

Diagnostics remain **incomplete**. Unknown context / statement counts are Native login 91 / 130, Web login 87 / 132, first Native startup 48 / 69 and first hosted startup 48 / 78. Capture overflow is false and droppedQueries is zero. The capture interval also spans work outside these windows; the original exports projected rows for the measured windows, not every row from that larger interval.

Physical / logical RPC starts and completions are 15 / 40 for Native login, 35 / 35 for Web login, 7 / 19 for first Native startup and 19 / 19 for first hosted startup. Every observed start completes and all crossing counts are zero in this run. The exact action tables are retained in rpc-diagnostics.safe.json.

## Cleanup and runtime boundaries

Lifecycle workspaceNameCleanup.restored is **false**, with phase **unchanged**. Its owner/peer sealed-baseline observations are false before and true after. Smoke has its own true-before / true-after owner and peer observations and workspaceNameCleanup.restored=true. Parity has its own restored=true result. These distinct observations must not be collapsed into an all-cleanup-pass claim. The recorded resource cleanup stages and leases complete; the original fields remain unchanged.

Both Native modes actually use installed daemon **0.0.551**, revision **facb389f6cc06c453e9135bb60ada1b0f302e0d9**. That installed daemon revision is not the candidate application revision. The Native job uses the macos-26 runner label; crypto evidence records darwin/arm64. An independent worker source hash is not present in this job log and is not inferred.

Five original JSON files are preserved byte for byte. original-files-manifest.safe.json records all 310 extracted member paths and hashes, and both ZIP byte counts and SHA-256 values match the GitHub API digests. The original ZIPs remain the GitHub Actions artifacts; ZIP download URLs and private platform responses are excluded from this folder.

The recovery VM only verified existing artifact bytes. It was stopped after 216210 ms, deleted, and exact named GET with resume=false returned 404 not_found. Active CPU was 8702 ms; ingress was 14935862 B and egress 383521 B. Cost was not measured. No Native run, model request, browser operation or production acceptance was executed in that VM.

The original job log retains its UTF-8 bytes including BOM/ANSI. Public files were scanned for credential shapes and email addresses; no values were rewritten. Two recovery command setup failures (wrong initial cwd and missing bundle-root environment) are preserved in the recovery receipt; they did not cause another artifact download or another Native execution.

These results establish this exact CI Native sample. They do not by themselves establish the whole CI result or production PostHog, Factory, replay playback, query reconciliation, screenshot or failure-injection acceptance.
