# Memory #1821 production API acceptance

The entry point is the existing **Mikka cloud core compatibility** workflow after a successful main Web deployment. It uses the existing shared-account queue and Infisical smoke identity. It has no dispatch trigger, provider write credential, webhook injection, direct database access or extraction endpoint.

## Source and release-window selection

Read-only selection precedes both account-secret reads. It requires the actual ordinary merge of PR #1830 (`feat/1821-memory-provenance-scope`): the current main/source commit has exactly two parents and its second parent is the PR's final head. The existing Core attestor binds the current main, actual successful Web run/attempt and deploy job steps, and the served `/mikka/api/version`.

An owner-authored #1752 comment also supplies exactly one marker. Substitute the actual full commit IDs and UTC timestamps, and generate a fresh UUID for `fixtureNonce`:

```text
<!-- mikka-memory-1821 {"state":"active","issue":1821,"pr":1830,"branch":"feat/1821-memory-provenance-scope","headSha":"FINAL_PR_HEAD","sourceSha":"ACTUAL_ORDINARY_MERGE","startsAt":"UTC_START","expiresAt":"UTC_END","phase":"inventory","fixtureNonce":"NEW_UUID"} -->
```

The window lasts at most two hours. Every business mutation, including workspace changes, pending review, model selection and prompt submission, rechecks the same unchanged marker and the exact production source. An expired, edited, replaced or released marker stops further business writes. Cleanup remains authorized only for this attempt's bound resources, even after expiry. Ordinary discussion comments do not change the lease.

Only Memory open does not run legacy Core business checks. The existing smoke-account reads require a selected Core business issue or this exact Memory selection. Unrelated main releases return `not_selected` before account access.

## Inventory and normal notification fixture

The first selected attempt can observe the normal owner GitHub connection and repository inventory while completing ordinary Memory CRUD and the two independent subscription cases. The report does not expose the connected login, repository list, account credentials or existing fact content. Repository listing alone does not prove that notifications are delivered.

Pending approval/rejection needs an actual new notification belonging to the authenticated test account. A release operator must first establish the existing normal provider connection and the notification's intended recipient. Use a real issue/PR comment delivered through that connection, with this literal marker in the original body:

```text
mikka-memory-1821:NEW_UUID
```

Do not fabricate a webhook or call an extraction/model endpoint to manufacture pending rows. Notification extraction is the product's existing built-in path; its policy, preference, entitlement and capacity gates remain unchanged. Empty pending output does not identify which gate prevented extraction. Do not send or retry a paid DeepSeek/API-key prompt for this fixture (AGENTS.md, live-model acceptance rule).

After the prior attempt has reached its terminal state and normal delivery has been observed, a fresh bounded #1752 marker can select the fixture phase:

```text
<!-- mikka-memory-1821 {"state":"active","issue":1821,"pr":1830,"branch":"feat/1821-memory-provenance-scope","headSha":"FINAL_PR_HEAD","sourceSha":"ACTUAL_ORDINARY_MERGE","startsAt":"ORIGINAL_UTC_START","expiresAt":"UTC_END_WITHIN_TWO_HOURS","phase":"fixture","fixtureNonce":"SAME_UUID","notification":{"provider":"github","url":"https://github.com/OWNER/REPO/issues/NUMBER#issuecomment-ID","bodySha256":"SHA256_OF_EXACT_ORIGINAL_COMMENT_BODY"}} -->
```

The fixture-phase marker retains the original window start and nonce; opening a later window whose start follows the event would not establish that this event was created in that window. Do not edit the marker while an attempt is running. The original comment must also remain unedited. The verifier reads GitHub's actual comment metadata, exact body hash, nonce, comment/issue identity and timestamps. Its start-bound comparison uses GitHub's whole-second precision; the exact nonce and body binding remain required.

The normal owner API then establishes all of the following before any pending mutation:

- The fact is pending, unedited and unused, with the exact verified `source.url` and `source.id = suggestion:<UUID>`.
- The same suggestion UUID is present in the authenticated owner's personal-workspace Inbox with `source = github`. Rewritten Inbox titles are never used as identity.
- Persisted `createdAt` is at or after the provider event, and persisted `firstSeenAt` equals its real event timestamp. An older fact that merely gained a source, or a revived old row, cannot be adopted.
- At most three new facts map to the single proved notification; an already-approved batch is refused. All other existing facts and pending items are retained unchanged.

The companion Memory API publishes the existing persisted creation timestamps; the driver does not infer them. External notification locators are visible only in their owning personal workspace, so this one source review temporarily selects that workspace. Model acceptance still runs in the authorized shared team workspace.

The driver tests source-workspace isolation, reject, normal short undo, approve and idempotent approval. It then normally removes all of this notification's bound facts and rejects only that exact Inbox notice. A low-ranked notification absent from Inbox, no extracted fact, a stale row or ambiguous provenance produces an explicit incomplete/failing result; it does not authorize selecting another item.

## Diagnostic retry without another paid case

There is no assumed manual dispatch. If the actual workflow service permits a diagnostic retry of the failed acceptance job after the missing fixture is supplied, retry the same workflow run and source with a new attempt and a valid marker. Changing the source requires new source-bound evidence.

Four dedicated confirmation steps record individually completed cases after the real driver has finished its cleanup:

| Case | Exact successful GitHub step |
| --- | --- |
| Normal owner CRUD | Confirm Memory owner API acceptance |
| Claude Code reply and real usage | Confirm Claude Memory reply and real usage |
| Codex reply and real usage | Confirm Codex Memory reply and real usage |
| Real notification pending review | Confirm Memory notification pending review |

Each confirmation checks the report's exact source, run ID, attempt, concrete case observations and successful cleanup. A subsequent attempt reads completed job metadata only from earlier attempts of the same run, with the same source and exact step name. A failed aggregate job can therefore preserve an already successful model case. Failed/skipped/cancelled steps, another run/source, a running job or a generic successful build do not establish a case.

A reused model case creates no Bot, changes no model and submits no prompt. A reused result is labeled `reused` with its original run/attempt/job/step proof; it cannot be confirmed again as newly executed. No raw workflow logs, response bodies or secret artifacts are used as authority.

## Results and cleanup

New model cases use only the fixed official Claude Code `claude-haiku-5-5` and Codex `gpt-6-luna` subscriptions. Each needs an actual committed response to a prompt that omits the hidden answer, and an increase in the nonce-bound fact's real `usedCount` with the newly created Bot's thread in `recentUses`. The paths run independently, without an API-key fallback or changes to shared model ordering.

`completeAcceptance: true` requires the normal owner checks, both real or precisely reused model cases, the real or precisely reused pending review, and successful cleanup. An absent fixture is never labeled as a passed pending check. Any demonstrated product/extraction-policy limitation must be reported with its actual evidence; this script does not infer an account or capacity cause from absence, force built-in extraction, or manufacture a pass.

Only new nonce/source-bound resources are changed. Normal fact removal leaves its short undo tombstone for the existing purge; there is no one-item purge API. New Bots are stopped, with a `working: false` readback, because there is no normal owner Bot-delete API. The original workspace and memory preference are preserved. Normal sign-out is followed by an old-cookie readback proving that the session no longer authenticates.

The uploaded JSON contains closed status/code observations, public source/window metadata and resource fingerprints. It does not contain passwords, cookies, bearer tokens, provider response text, existing private facts or account identity. Offline guard tests validate the consumer and its refusal boundaries; they are not production acceptance receipts.
