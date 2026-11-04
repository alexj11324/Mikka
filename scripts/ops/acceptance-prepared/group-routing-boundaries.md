# Group routing addon — prepared draft, not executed

This independent module does not alter the reviewed core bundle. Its latest sixteen offline transport contracts pass. This compatibility/cleanup increment still needs independent review, and a standalone login/workflow adapter must be bound separately before activation. No real model or provider invocation was performed for these contracts.

The real core production run 41762211922 failed its Decision checks. This addon must not run against that failed report or claim it met routing acceptance. The projected-report interface rejects a failed core or group before any network request. Root owns any future activation after a separately verified passing core report and a matching production source/deployment.

## Scope and evidence

The eight maximum message attempts are natural casual chat, unrelated content, a non-mention Coding question, its answered-question closing, a non-mention Testing question, UI then Testing incremental advice, the next message after a public-role change, and a valid mention of an owned Bot temporarily removed from the group.

Each normal turn must finish with the actual sequential Decision chain for the exact source Decision model. The primary receipt identifies index0 of the current attempt; every current step must carry the same frozen candidate policy, and every retained step/receipt must have a unique ID. Historical failed steps remain visible. Silence requires zero wake, generation, publication, or public Agent reply; replies require exactly one wake, generation and publication for each expected responder. The two-perspective check requires first publication before the second generation, distinct content digests, and concrete interface/verification content. These bounded content checks do not establish general semantic usefulness.

The actual group authorization API returns 422 invalid_input for the legal nonmember mention shape. The driver proves the Bot belongs to its fixture owner, verifies its removal through the normal member GET, submits the valid shape once, verifies no new message or turn, restores membership normally, and verifies the original member set. A schema-400 response cannot pass.

The module budget is at most ten minutes, with up to180 seconds (one third of the supplied budget) reserved for cleanup. Its eventual session adapter must reserve its logout/key-removal time within its own ten-minute total deadline; the module does not own those sessions or credentials. The transport must honor the supplied AbortSignal. verifyTarget receives a signal and is additionally raced against the timeout. The same accepted message is polled for up to120 seconds inside the work budget, including failed/group_judgment_pending recovery. An absent, expired or uncertain trace is not silence. The module never retries a message to obtain a passing model result.

observedDecisionReceipts remains the compatibility count of primary receipts/turns. providerCalls separately records retained steps, distinct authentic provider receipts and unreceipted steps. Known paid routing costs are deduplicated by provider generation; unknown amounts or incomplete turn observations keep completeCostUsd null. These figures cover routing-decision-chain only, not correction/contribution judgments, generated replies, Factory work or runtime spend. An empty failure trace cannot prove zero provider calls.

## Inputs

runGroupRoutingBoundaries accepts an already signed-in owner.request(path, init) returning a normal Response, verifyTarget({signal}), the exact source assertFlashTestModel function and decisionModelId, and one exclusively used fixture.

The preferred later-run fixture is:

    {
      exclusive: true,
      coreBundleStatus: coreReport.status,
      creationReport: coreReport.group,
      reportSha256: sha256(JSON.stringify(coreReport.group)),
      sourcePin: { revision: expectedCommit, deploymentId: expectedDeployment }
    }

Both the actual core status and group status must be pass. The caller must verify the actual artifact provenance and whole-core status. This is explicitly named fixed-core-group-report-projection, not an invented raw HTTP 201 response. The module checks its hash and source pair, then rechecks live owner, marker names, group creation time, exactly three fixture Bots plus the sole owner, public roles, and model menus.

The alternative same-process fixture accepts actual 201 Bot and conversation receipts from that process, with fixtureId, ownerId, workspaceId, startedAt, and role/model mapping. It is not a way to synthesize a successful receipt from a failed core.

## Temporary credential binding

The standalone adapter must use the normal source helper with cloudExecution:false and only the named existing Smoke and Flash inputs. It must not read or configure E2B for this routing test.

Deleting a temporary core key invalidates its saved Bot key IDs. Recreating a key does not repair those preferences. allowFixtureFlashSelection:true explicitly permits normal GET/PUT model selection only after passing core provenance and live fixture ownership checks. It chooses an already-authorized personal DeepSeek API-key option for the same exact Flash model recorded by the core. It records modelSelectionChanged and each affected Bot ID, reads the selection back, and guards every prompt. No hosted/subscription/Pro fallback, model-order change, or historical Bot modification is allowed. Removing the new temporary key later leaves those synthetic Bots to the product's normal fallback behavior; the old deleted key ID is not restored.

## Cleanup and limits

The original publicRole is retained only in memory and restored exactly. Unknown writes are read back and never blindly repeated. A role or member set changed by another actor is not overwritten. Unknown restoration acknowledgements remain visible even when the final state is observed restored.

Unexpected delegation is a failure and ends further messages. Finally, after restoring the temporary role/member changes, normal group stop is sent at most once for the proven fixture and the trace is read back without another messages drain. Group stop only fences group chat; it does not cancel Factory Tasks or end machines. The final decisions scan therefore covers every confirmed HTTP201 root from this addon even when terminal polling timed out, and waits read-only within the cleanup budget for a host delegation receipt that arrives after stop.

Cancellation requires this module's new confirmed message and trusted delegate event to join the current Task request epoch, exact run set, issue, reporter and frozen requester/principal/outputOwner/Bot/workspace/runtime-payer identity. The normal Task cancel is sent once if needed. The exact run set must then be observed terminal; identity/epoch/run membership are checked again before normal per-run machine end. Each Task/run pair is attempted only once, including when the earlier scenario path already saw it. An E2B end is acknowledged only by the normal200 ended response; local-device runs do not receive a Cloud end. independentProviderObservation remains false. Unknown stop/cancel/end responses are not resent and are not described as acknowledged.

A lost message response does not establish a root ID. A later delegate belonging to such an unknown submission is marked unbound and is never guessed into a Task cleanup. Foreign identities, changed epochs/run sets, missing receipts and unknown end results remain explicit unresolved cleanup. requiresScopeCleanup remains conservative for unknown submissions, timed-out/unobserved traces or unresolved cleanup; a failed case never becomes acceptance success merely because its cleanup succeeded. The standalone adapter still owns logout and temporary-key removal, and must preserve these cleanup observations.

The output contains IDs, counts, safe status codes, hashes, and receipt projections. It contains no prompt/reply text, role text, URL, credential labels, emails, cookies or secrets. The 24 fixed replay remains a separate core requirement.

## Offline checks

    node --test group-routing-boundaries.test.mjs
    node --check group-routing-boundaries.mjs

Current result: sixteen tests passed, zero skipped, using injected transport only. The earlier quiet-wake regression remains. Five new contract cases failed against the previous module, demonstrating recoverable pending early exit, missing reply wake/chain false passes, missed timeout/late-delegation cleanup, unknown-POST scope cleanup and missing terminal-machine checks; they pass after this bounded update. The suite also preserves owner/model/role/member and malformed422-contract negatives, and retains known/unknown cost for a paid uncertain failure. Final independent review and the normal standalone session adapter are still required before execution.
