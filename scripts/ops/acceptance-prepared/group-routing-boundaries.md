# Group routing addon — prepared draft, not executed

This independent module does not alter the reviewed core bundle. Its latest ten offline transport contracts pass, but the final independent review and its standalone login/workflow adapter remain pending. No real model or provider invocation was performed for these contracts.

The real core production run 41762211922 failed its Decision checks. This addon must not run against that failed report or claim it met routing acceptance. The projected-report interface rejects a failed core or group before any network request. Root owns any future activation after a separately verified passing core report and a matching production source/deployment.

## Scope and evidence

The eight maximum message attempts are natural casual chat, unrelated content, a non-mention Coding question, its answered-question closing, a non-mention Testing question, UI then Testing incremental advice, the next message after a public-role change, and a valid mention of an owned Bot temporarily removed from the group.

Each normal turn must finish with a real Decision receipt for the exact source Decision model. Receipt execution and generation IDs cannot repeat. Silence requires zero wake, generation, publication, or public Agent reply. The two-perspective check requires first publication before the second generation, distinct content digests, and concrete interface/verification content. These bounded content checks do not establish general semantic usefulness.

The actual group authorization API returns 422 invalid_input for the legal nonmember mention shape. The driver proves the Bot belongs to its fixture owner, verifies its removal through the normal member GET, submits the valid shape once, verifies no new message or turn, restores membership normally, and verifies the original member set. A schema-400 response cannot pass.

The work budget is at most ten minutes, with the final tenth reserved for cleanup. The transport must honor the supplied AbortSignal. verifyTarget receives a signal and is additionally raced against the timeout. Polls wait for a terminal trace; an absent or pending trace is not silence. The module never retries a message to obtain a passing model result.

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

Unexpected delegation is a failure and ends further messages. Cancellation is allowed only after joining this module's new message and trusted delegate event to the current Task attempt/epoch, run, issue, reporter and frozen owner/workspace identity. Only a normal cancel action is sent once. cancellation-recorded does not mean the executing Agent stopped. Missing or mismatched receipts produce needs-scope-cleanup; the driver never guesses a Task ID. The standalone operator must preserve any failure and follow up through normal scoped cleanup.

The output contains IDs, counts, safe status codes, hashes, and receipt projections. It contains no prompt/reply text, role text, URL, credential labels, emails, cookies or secrets. The 24 fixed replay remains a separate core requirement.

## Offline checks

    node --test group-routing-boundaries.test.mjs
    node --check group-routing-boundaries.mjs

Current result: ten tests passed, zero skipped, using injected transport only. A meaningful red case first demonstrated that a quiet wake could pass the earlier draft; the explicit zero-wake assertion then made it pass. Final security/cleanup review is still required before execution.
