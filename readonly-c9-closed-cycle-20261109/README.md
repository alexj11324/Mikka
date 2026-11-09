# Successful c9 preparation and exact child cleanup — 2026-11-09

This is the closed operational connection cycle supporting the already authorized P0 consumer. It is not a production startup-latency acceptance.

Preparation source c9b6f9531aa40dde6142291e2ce6bac476c5cea5 ran as 42622019169/1, job129176310154. Its final report at 13:27:51.104Z was passed/changed=true with connected, samePrincipal, repositoryAccessible and sameAppInstallation all true. The normal Owner getter used minimumValidityMs660000 and committed; persisted Owner metadata did not change and actual refresh was not independently observed. The token value was never recorded here; the exact child SHA256 was 1d1fee15399de66a97e389dabb2e48e8f215db9315f62e0f8a10645bf63fb93b. Its permissions were metadata:read and contents:read, scoped to the original Mikka-handoff repository.

The prepare log is the once-read complete decoded UTF-8 original (58129B / 275b9cdf027b577476076c0ca8b2cf5b7a5e45ab3a2e911d81dc0126dacec2bc). The report extracted from that log retains GitHub's appClientId mask; it is explicitly not the original receipt's byte representation. The prepare entry was closed by sole child465f1b89c52228b99c4f2424f92722901b910754; its close run42626423105 was SKIPPED.

Artifact13677458654's exact925B ZIP has digest87124f31fd4cfc332411985814650992fcdad9f21ca6f5a0709f70abb5c41a81. The first tool image expired before any local byte read. Root recovered a second image of the same fixed artifact, and the offline worker fetched that image once. Actual original receipt.json was2132B / 80031945234e34264c558f830bd64bfa651858e69dbfdfa6354b62deb2a2022d. The original ZIP/receipt and raw appClientId are not republished here. Exact offline test source,15 cases, byte pins and VM closure are in the sibling readonly-c9-cleanup-preflight-20261109 directory.

P0's public handoff6741560032 confirmed its actual13:37:04.206–13:39:20.259 consumer finished and its Task/Run/VM resources were cleaned. That handoff did not replace this operator's independent idle and exact-child checks. P0's report failures and Bot model-restore issue remain separate.

Cleanup source e5a50fa1d227eca754eb41dc0fc39a14ffd5d377 ran as42628278002/1, job129197622148. The one workflow change preserved all five c9 execution/test files, the five original Infisical scopes, and both existing queues. It bound the successful original run/attempt/workflow/head/repository, artifact metadata, ZIP digest and sole original receipt member. The runner independently downloaded and verified that same immutable artifact before credential access and cleanup. This operational revalidation is distinct from the earlier offline image inspection.

The workflow checked current main111a before/after installation and immediately before cleanup. Its10-minute job,13:49 entry and13:59 hard end were fixed. Runtime cleanup did not refresh Owner credentials or mint any token. Existing eight-idle guards and exact child/CAS matched.

The final cleanup report at13:46:34.061Z was passed, stage disconnect_exact_child, revoked=true, disconnected=true, revocation.kind=delete_token and HTTP204. The once-read complete decoded cleanup log is427483B / 622a203bc5cd0844ce551400f108a6e5aeef600ba498c7fb15706001c7cb6da1. These are decoded-log hashes, not ZIP hashes.

Cleanup result artifact13679232155 metadata is324B / ZIP digest e928378bebf3c3436c109bfe4a85e0dd40d1c37bb21080e3b6dd03c6423c0cb6. Root did not download that result ZIP; the conclusion comes from the actual final log report. The cleanup entry was closed through sole child e93477fe401c70dca532784e71b76d56877b6899, only if:false/GO empty. Ref readback and close run42628604278/1 SKIPPED confirm closure.

The unused pending-cancellation drafts were never referenced or executed, because prepare completed before the operational cutoff. No other run was cancelled.

This closes only this child and these operator entries. It does not assert global zero resources, complete the P0 acceptance, publish a runtime, or provide any of the six required production startup samples. New formal CCx3/CXx3 samples remain zero.
