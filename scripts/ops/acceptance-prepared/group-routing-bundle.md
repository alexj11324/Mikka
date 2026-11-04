# Routing addon normal-session adapter — prepared only

`group-routing-bundle.mjs` exports `runGroupRoutingBundle`. It has no CLI, no work on import and no installed workflow. No real invocation has been performed. It calls the separately reviewed `group-routing-boundaries.mjs` and does not change the core or policy rollback bundle.

## Required evidence and source

The caller supplies the exact UTF-8 `coreReportJson` bytes downloaded from the verified core workflow artifact and its known `coreReportSha256`. The adapter checks the hash before any network operation, requires the whole core and its group to pass, requires24 receipted/completed logical replays with complete collection and accepted quality, and requires the core/group source and deployment to match `GROUP_ACCEPTANCE_REVISION` and `GROUP_ACCEPTANCE_DEPLOYMENT`. It also checks the exact clean source checkout and the canonical production `/api/version` build. A failed, partial or differently deployed core cannot be substituted.

A matching caller-supplied digest alone does not authenticate the artifact's GitHub origin. The caller must retain the verified workflow/job/artifact identifiers and download digest. The report explicitly leaves `artifactProvenanceVerifiedByRunner:false` and records the fixed bytes/source/fixture references. It does not synthesize HTTP201 receipts; the routing module uses its named, hash-bound core-report projection and rechecks normal live fixture ownership.

## Normal account and credentials

The source's existing `isSmokeAccountEmail`, `assertFlashTestModel`, `DECISION_MODEL` and `withTemporaryFlashCredential` are imported from the fixed checkout. Only the named `SMOKE_OWNER_EMAIL/PASSWORD` normal account and existing authorized Flash secret input are used. The canonical origin is fixed to `https://app.aspectlylabs.com`; redirects, other origins and credential-bearing URLs are rejected.

The adapter logs in normally, verifies the returned session ID equals the core fixture requester, then enters the existing temporary-key helper with `cloudExecution:false`. It creates no E2B key. The routing module may reselect the available same Flash option only for the three proven core fixture Bots, since the earlier temporary key may have been removed. It cannot change historical Bot preferences or model order. The source module still rechecks owner, membership, roles, model availability and source/build before messages.

## Budget and cleanup

The total adapter budget is600 seconds. Routing gets at most535 seconds and less if setup used part of the deadline;65 seconds are reserved within that total for temporary-key deletion, helper logout, final version read and owner logout (each request is capped at15 seconds). Within its own budget the routing module separately reserves up to180 seconds for role/member restoration, group stop and receipt-bound Task/VM cleanup. No message is replayed after an unknown outcome, and the absolute message limit remains eight.

The helper normally rediscovers public Settings action references for each write. To keep the final four requests bounded, this adapter uses its existing discover argument to call the same source publicCredentialActions function once, before creating a new key, requesting both createApiKey and deleteApiKey. Only these genuine references from the fixed build are cached in memory; cleanup does not rescan assets or invent an action ID. Existing keys need neither discovery nor a credential write. If a build change invalidates a cached deletion reference, cleanup remains failed; no fallback write or success claim is made, and normal logout is still attempted.

The routing module finishes its cleanup before the helper removes a newly created key and ends its session. Finally the adapter logs out its own fixture session once. Passing requires the routing result to pass, any created key to be removed, both distinct normal sessions to have actual HTTP200 logout acknowledgments, an unchanged final build, and the total elapsed time to remain within ten minutes. Unknown or failed cleanup remains failed and is not retried into a pass. Existing credentials are preserved by the source helper. A per-run machine end acknowledgment remains a product acknowledgment, never an independent provider observation.

The adapter returns a safe report, not console output. The eventual caller can use the reviewed core bundle's `writeSanitizedReport` to persist it. The original core bytes are not copied into that report; prompts, replies, role text, email, cookies, passwords and keys are not emitted. Actual activation, final source/build pins and the verified core artifact are a separate owner-controlled step.

## Offline checks

`node --test group-routing-bundle.test.mjs` and `node --check group-routing-bundle.mjs` are pure Node checks. Nine transport contracts cover fixed artifact/source/scope preconditions; ordinary session-before-helper ordering and dual logout; failed/partial/mismatched core refusal before network; source/deployment/account rejection; failure cleanup and post-run drift; unknown cleanup without replay; four cleanup segments of15 seconds with cached public references; preserving an existing key without any action write; stale/unknown deletion references with no rediscovery or replay and both logouts attempted; and the fixed-origin credential transport. The inner routing operation is injected in these wrapper contracts; its16 separate contracts cover actual routing/receipt/cleanup behavior. Neither suite is a production or provider result.
