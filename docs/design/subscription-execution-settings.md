# Subscription and execution settings

This is an implementation clarification for Alex's 2026-11-02 request to
review and fix subscriptions, API keys, Agent dispatch and other settings
using domain modeling and Nielsen's heuristics. The preferred-model label and combined Agent card follow CC PR #1053
(`5f9e322`), which records Alex’s request. The additional scope headings and
recovery changes below remain this implementation’s review proposal. Existing decisions 1400, 1700 and 2240 still govern dispatch,
same-model quota fallback and personal credential ownership.

## Objects and scopes

| Object | Saved for | Controls |
| --- | --- | --- |
| Subscription or API key | Account | Authorization, model allowance and API charges |
| API-key-after-quota preference | Account | Whether exhausted subscriptions may continue on a compatible key for the same model |
| Bot chat choice | Bot and its owner in its workspace | Next reply's model and credential |
| Thread defaults | Person within the current workspace | Ordered model and Agent defaults when no model was explicitly requested |
| Run location | Person within the current workspace | Default cloud or local placement; an explicit task destination overrides it |
| Device participation | Account's device | Whether the scheduler may use it |
| E2B key | Account | Cloud compute; it does not authorize model usage |
| Share | Credential and team workspace | Other members' use, subject to current membership and sharing policy |
| Execution snapshot | One run | Frozen model, Agent, credential and machine |

One's own credential works across one's workspaces without an additional
workspace-use switch. A share never changes the credential owner into the
run owner. Admission resolves the explicit share and both memberships before
issuing the machine's assignment. Later revocation pushes a stop or reclaims
the VM, without adding remote authorization before every provider/tool call
([1800](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)). A Bot's
chat API-key preference never overrides an explicitly resolved thread credential.

## States and recovery

Connection, model allowance and machine readiness are separate facts.
Unknown or stale allowance is **待检查**, and dispatch checks it without
requiring Settings to have been opened first. An exhausted Opus window does
not exhaust unrelated Claude models. An inconclusive check does not trigger
paid-key fallback.

The composer projects the same resolution used to freeze the next reply.
The collapsed chip shows the model's icon and name. Credential names and
email addresses stay in the expanded picker; it has no **Next / 下一条**
prefix. Changing the choice leaves the current run's snapshot intact.
Quota and paid-fallback notices keep their existing source and billing
details. Retry distinguishes queued, already working, no reply to retry and
failure; it does not acknowledge a request that was never queued.
The failure title and recovery action share a vertically centered, wrapping
row; retry feedback contributes to its height rather than overlapping content.

Provider errors cross the worker boundary as finite safe reasons. The UI
offers retry, model choice or the appropriate settings destination without
returning raw provider responses. Cloud startup reports a missing E2B key
only when absence is known; other failures do not ask the person to add an
already configured key.

## Task walkthrough

| Task | Before | Intended result |
| --- | --- | --- |
| Connect a subscription and chat | Extra usage could disable a working account | Both subscription providers remain usable within their actual allowance |
| Distinguish two same-plan subscriptions | Same labels | Model plus account or shared owner identifies the source |
| Dispatch after choosing a chat API key | Chat preference could replace the task source | The selected thread model and credential stay frozen |
| Create a task | Independent cloud-first default overwrote run location | Unchanged placement inherits thread defaults; only explicit choices pin a destination |
| Use a shared subscription for an Agent | Candidate, queue and claim disagreed | All stages use authorized access to the real credential owner |
| Resolve unknown model quota | Available or generic unavailable, sometimes no way forward | Checking, bounded refresh and a usable retry path |
| Repair a blocked row | A general page or wrong credential group | Matching subscription, key, device or existing E2B dialog |
| Inspect subscription usage | Historical bindings called current use | Current workspace's explicit chat choices, with workspace identity |
| Load payment or shared-link settings | Errors could look blank or empty | Loading and failed reads remain visible and retryable; known links remain manageable |

## Verification boundaries

Deterministic source and DOM tests cover choice, finite recovery states,
read failures and model-specific quota. Real isolated PostgreSQL tests cover
credential freezing, workspace scopes, dispatch, claims and thread counts.
The subscription worker and pinned native Agents require live provider
acceptance on both official subscription paths, Claude Code (`claude-haiku-5-5`)
and Codex (`gpt-6-luna`). A blocked path is recorded independently while the
other continues. API-key execution does not gate acceptance. A mocked stream
or successful candidate list does not establish provider acceptance. Production-build screenshots and their
review remain distinct from API/CLI verification. See the PR's immutable
revision and evidence for what was actually run.
