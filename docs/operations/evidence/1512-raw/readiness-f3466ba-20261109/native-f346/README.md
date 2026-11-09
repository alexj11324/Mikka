# Native evidence for f346 / CI 42610943512

This folder preserves one natural Native execution, job 129141935329, completed successfully at 2026-11-09T12:08:15Z. Its own checkout, build output and original JSON identify 855245dba9accc3212dab9fd28af398af1a7e65a, tree 102bc671b4c5e3cf49fcce54025c71b26f817cf2, exactly the candidate tree of f3466ba479ef51918790f521a288feaef5160e44.

## Original query budgets

| Original measured window | Native | Same-source Web / hosted | Result |
| --- | ---: | ---: | --- |
| Full login including email authentication, PKCE and concurrent background | 426 = 19 + 13 + 394 | 435 = 19 + 0 + 416 | 426 <= 435 |
| Original first startup pair (pair 1) | 158 | 233 | 158 <= 233 |

No requests were subtracted, no later pair was substituted, and no CI rerun was requested. These are newly read f346 results; no ae10 numerical result was reused. The 24 records, 12 checkpoints, 8 segments, 17 operation buckets and 78 source buckets reconcile. All 1252 projected query ordinals in the four measured windows reconcile with their original scopes and bucket counts.

Diagnostics remain **incomplete**. Unknown context / statement counts are Native login 91 / 129, Web login 87 / 132, first Native startup 53 / 53 and first hosted startup 53 / 77. Capture overflow is false and droppedQueries is zero. Only the four measured windows' query rows are projected, not every row from the larger capture interval.

## RPC window crossings

Full Native login has 14 physical requests and 40 logical actions; Web login has 35 / 35. Their starts and completions are equal within the windows. First hosted startup has 19 / 19 and all complete in-window.

**First Native startup has 5 physical starts but only 3 physical completions in-window, and 14 logical starts but only 13 logical completions in-window.** Two physical desktop.readBatch requests cross the end; one logical coordinator.syncCoordinatorChat crosses the end. Those completions are observed later with status 200 and completionNotObserved=0. The original endpoint, query totals, protocol-byte boundary and all background traffic are retained. This must not be summarized as all first-pair requests completing inside the measurement window. Exact physical and logical action tables remain in rpc-diagnostics.safe.json.

## Cleanup and runtime boundaries

Lifecycle workspaceNameCleanup.restored is **false**, with phase **unchanged**. Its owner/peer sealed-baseline observations are false before and true after. Smoke separately records true-before / true-after for both owner and peer, and restored=true. Parity separately records restored=true. These fields must not be collapsed into an all-cleanup-pass claim. The recorded native-resource stages and lease releases complete; original fields remain unchanged.

Both modes actually use installed daemon **0.0.551**, revision **facb389f6cc06c453e9135bb60ada1b0f302e0d9**. This is not the candidate application revision. Bundled readiness is 5478 ms / 18 reads; hosted readiness is 16 ms / 1 read in its already observed environment. Both have no recorded navigation interruption, overflow or failure. This does not claim that a fresh daemon installation takes 16 ms.

The Native job uses macos-26; crypto evidence records darwin/arm64. No independent worker source hash appears in this job log, and none is inferred. Five original JSON files are preserved byte for byte; the member manifest records all 310 extracted paths and hashes. Both ZIP byte counts and SHA-256 values match GitHub API digests. Original ZIPs remain the GitHub Actions artifacts; signed download URLs and private platform responses are excluded here.

The recovery VM only copied and verified this run's artifact bytes. It was stopped after 155545 ms, deleted, and exact named GET with resume=false returned 404 not_found. Active CPU was 6808 ms; ingress was 14932318 B and egress 397039 B. Cost was not measured. No runtime tests, models, production browser actions or acceptance requests ran in it. All recovery commands completed on their first invocation; no artifact link was refreshed.

The original job log retains its UTF-8 bytes including BOM/ANSI. Public payloads are scanned for credential shapes and emails without rewriting source bytes.

This evidence establishes this exact CI Native sample. It does not establish the whole CI result or production PostHog, Factory, replay playback, query reconciliation, screenshot or failure-injection acceptance.
