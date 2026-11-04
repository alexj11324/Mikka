# Original Codex 390: production recovery and Owner acceptance after #1250

## Result and release identity

On 2026-11-04 the original Factory task `9ea956ce-a604-4c2e-a724-fb04fa5a3c9b` reached **approval / passed, revision 35**, through one normal Owner re-review and one normal Owner acceptance. Candidate **b251f0b5-3aa6-4e70-b57a-282161c969a1** and original producer **390deeb4-5e5b-487a-acb9-c2e53dc3f8e9** were preserved. There was no replacement producer.

Application build: **56a499e9079e2b8d8964162658739c2848204ed9** (#1250 squash). GitHub Actions **Web deploy 41892907715** completed successfully. The public version endpoint returned HTTP 200 and exactly that build at **19:07:27 UTC** before the action and **19:21:27 UTC** after acceptance. See [release-pin.json](release-pin.json) and [public-version-after.json](public-version-after.json).

This is a real production acceptance of the existing **85-byte recheck candidate**. It is not a claim that the earlier 77-byte continuation passed, or that read-only report checks ran an independent shell command.

## Preserved task and fixed candidate

| Field | Value |
| --- | --- |
| Issue | 65e92e1e-4d75-4531-b1bd-a2a68d7689c7 |
| Bot | 0c2865c3-7d69-49d2-a3fd-02c484621958 |
| Workspace | de300000-154f-4875-832f-70e7ffc3b62b |
| Original producer | 390deeb4-5e5b-487a-acb9-c2e53dc3f8e9 |
| Original native SID | 01a1a2a5-76f1-7881-b182-311eba17fa98 |
| Candidate | b251f0b5-3aa6-4e70-b57a-282161c969a1 |
| Snapshot | 8f418086fff9bcd42d17e32de7b7f4a968fdfc0a |
| UTF-8 bytes | 85 |
| SHA-256 | 4e80716f5de244c05cab6f9fdf3d93c90f35fc2cabcf4a07ae79772c48d35032 |

The expected content remains the frozen original recheck target, with an LF after each line:

```text
factory-1146-codex-d8f3d3f2 resume-1146-recheck-6a265954
7 - 4 = 3
verified artifact
```

## Real fresh independent checks

The re-review action created event **531dbd62-042c-4177-9e8a-16d25a46a452** at **19:12:36.064569 UTC**. It briefly remained pending; the Owner did not repeat the action or manually wake a VM.

| Stage | Run | Native SID | Actual runtime | Result |
| --- | --- | --- | --- | --- |
| Review | 4545fb6d-745f-4997-8785-5d263a67de96 | 01a1a7fc-b873-7af2-a269-8f52cedb90c4 | 19:14:56.825–19:16:35.589 UTC | Factory attempt passed |
| Verify | 03e5559f-c67d-455b-813f-d64b085a7907 | 01a1a7fe-675c-7ac0-8159-563ca54fb6dc | 19:16:47.839–19:18:38.455 UTC | Factory attempt passed |

Both actual claims were **Codex / gpt-6-luna / explicit CLI selection / codex_cli**, one native claim per run, zero API-key claims, with original subscription connection **ef66c1d8-2bbc-48e9-abf3-2ce3787ceef5**, revision 2. The independent SIDs differ from each other and from the original producer.

Each run performed a new `mcp__mikka__inspect_artifact` call with the complete expected UTF-8. Each actual output returned 85 bytes, the expected SHA-256, the fixed HEAD, matching committed SHA, `contentMatchesGit=true` and `matchesExpectedUtf8=true`. Review output chunk: **b8dc9859-7dd3-4da5-9eb2-bd0ad9b54b3b**. Verify output chunk: **19fc2738-b55e-408a-8f25-3f52d463fa71**.

These are `reportOnly=true`, `command=null`, read-only artifact checks. The low-level report field `verify.status=not_run` correctly records the absence of a shell verifier; it does not contradict the separately passed Factory artifact verification. No shell or unsupported tool was enabled.

Actual narrow tool input/output, final reports and native identities: [review-native-evidence.json](review-native-evidence.json), [verify-native-evidence.json](verify-native-evidence.json), [independent-checks.json](independent-checks.json).

## Provenance, including the retained failed predecessor

Both checks received and actually cited the validated pre-question command output:

- Source run: **e57a6d03-510e-496f-bd88-97375318cd9e**.
- Source remains **failed / error**; its status was not rewritten.
- Native SID: **01a1a2a5-76f1-7881-b182-311eba17fa98**.
- Actual command output chunk: **da925461-a884-428d-a024-62d647a50cb2**, observed **2026-11-03T20:38:02.950Z**.
- Immutable recovery event: **ec982956-3302-5588-bcac-2a209a5db623**.
- Bound candidate snapshot: **8f418086fff9bcd42d17e32de7b7f4a968fdfc0a**.

The referenced command's actual exit 0 and output prove its exact-content, byte-count, hash, arithmetic and Git checks. It is labelled as execution **before the question**, not as fresh shell execution by 390 or by either checker. Both result rows visibly showed **来自提问前的执行 11/3 20:38**. The normal **查看执行** button opened the actual source run, and its real Bash tool entry was visible.

The old 485 review attempt remains failed; the old run's succeeded/submitted status only means that it submitted its failed review report. See [historical-status-preserved.json](historical-status-preserved.json).

## One Owner acceptance and clean completion

At revision 34 the normal UI showed 4/4 checked. The Owner clicked **验收** once. Event **cdb3ccbd-96c0-4090-ac10-e4975bf636a2** at **19:19:39.832346 UTC** created acceptance **99cf0bd3-ba56-4b0f-9fa4-9ae366bc1663**. A read-only query confirmed exactly **one** acceptance for this candidate. Final task state is **approval / passed / revision 35** and the UI says **已验收**.

See [owner-acceptance.json](owner-acceptance.json). Its acceptance projection excludes the web authentication session identifier.

At **19:21:15 UTC**, actual active runs and unexpired Owner leases were both zero. The temporary model configuration still exactly matched its saved post-change fingerprint. Normal UI restored the known preflight model order: original Luna, original Opus, original older Luna, with their original source connections and preferred harness. At **19:22:35 UTC**, read-only reconciliation confirmed semantic restoration and zero active runs / leases. Removed and re-added order entries have new UUIDs and timestamps; this is explicitly **semantic restoration, not byte-identical restoration**. See [restore-guard.json](restore-guard.json) and [preferences-restored.json](preferences-restored.json).

Before fingerprint: `3e7c7746ad2a1b1462adc9c64fffa41d753feab2faab8679588beae3241c565f`.
Temporary fingerprint: `022eaa44f51cf2571cfe62d9ed515decca6e435576d3541b53d67127cdded73e`.

## The sidebar's 77-byte historical notice

A read-only trace found the 77-byte request in this same issue's earlier chat message **e9826faa-0e89-4db9-bbf1-b011fbec7615**, at **2026-11-03T17:36:23.314Z**. Later actual frozen Owner requests for runs 0c2a, E57 and 390 explicitly selected the new 85-byte `resume-1146-recheck-6a265954` epoch and said older initial or failed follow-up byte targets must not replace it. The coordinator's later sidebar messages continued referring to the old 77-byte chat request.

[historical-contract-trace.json](historical-contract-trace.json) preserves the relevant earlier request, later actual run prompt excerpts and current notice. No chat history, criteria or candidate was changed to suppress the discrepancy. This evidence claims only the original390/b251 85-byte recovery path requested by #1237.

## Production screenshots

These are actual normal-Owner production browser captures, not local fixtures.

| Image | What it establishes |
| --- | --- |
| [before-1250.png](before-1250.png) | Retained failed state before the new deployment/action |
| [codex-only-luna.png](codex-only-luna.png) | Original subscription model fixed before dispatch |
| [review-pending.png](review-pending.png) | Exactly one re-review, pending state |
| [review-source.png](review-source.png) | Fresh review and source attribution |
| [source-execution.png](source-execution.png) | Normal source navigation and actual original command |
| [owner-ready.png](owner-ready.png) | Independent checks complete, awaiting Owner |
| [owner-accepted.png](owner-accepted.png) | Final accepted state |
| [preferences-restored.png](preferences-restored.png) | Known preflight model order restored |

[manifest.json](manifest.json) records file byte sizes and SHA-256 hashes. No credential values, raw authentication sessions or model reasoning streams are included.
