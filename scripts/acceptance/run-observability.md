# Issue #1512 production run driver

The driver uses the existing ordinary account login and normal browser API
transport. Credentials stay in the GitHub Actions runner. It creates no tokens,
logs into no model provider, changes no workflow and makes no direct database
writes.

## Commands

Node 24 is sufficient; no package installation is required.

    node --test scripts/acceptance/run-observability.test.mjs
    node scripts/acceptance/run-observability.mjs
    node scripts/acceptance/run-observability.mjs --execute

The second command is a read-only business preflight. Sign-in and sign-out create
and close only its own authentication session. The third command is the explicit
execution boundary; without that flag it submits no messages or tasks.

The manual workflow is .github/workflows/run-trace-acceptance.yml. It supplies
these environment variables:

| Variable | Meaning |
| --- | --- |
| ACME_DEMO_EMAIL | Existing authorized acceptance account, loaded by Infisical OIDC |
| ACME_DEMO_PASSWORD | That account's password, used only inside the runner |
| MIKKA_EXPECTED_DEPLOYMENT_SHA | Required exact 40-character main SHA served by /api/version |
| MIKKA_OBSERVABILITY_MODEL_CASE | all (default), claude or codex |
| MIKKA_OBSERVABILITY_TIMEOUT_MS | Per-case deadline, default 480000; permitted 60000–600000 |

The origin is fixed to https://app.aspectlylabs.com/mikka. An optional
MIKKA_ACCEPTANCE_BASE_URL is accepted only if it equals that exact URL.
All HTTP redirects are refused.

## Preflight gates

The report gives closed failure codes, never upstream error text.

| Code | Required state |
| --- | --- |
| build_mismatch | Production must serve the supplied immutable SHA before and throughout the case |
| workspace_missing | The signed-in account must own an admin personal workspace |
| workspace_busy | Workspace bot runs, owner threads and existing Factory tasks must be idle/terminal |
| task_inventory_truncated | The visible task inventory must contain fewer than its 100-row API cap |
| coordinator_disabled / coordinator_busy | Coordinator enabled, no working turn or pending human input |
| model_not_restorable | Existing composer choice explicitly saved, available and present in its menu, with no current fallback |
| paid_fallback_enabled | The existing subscription-to-API-Key fallback setting must be off |
| profiles_active | No existing enabled Agent Profiles in this owner/workspace |
| source_missing / source_ambiguous / source_blocked | Exactly one usable owned subscription source for the exact required model |
| cloud_unavailable | Existing owner cloud configuration and model support ready |
| live_unavailable | Authenticated live channel exposes bot_chat, run, factory_task and factory_issue invalidations |
| previous_fixture | This deployment/model has already created its deterministic Profile; never silently spend again |

These are observed configuration conditions. The driver does not change global
model order, existing Profiles or the API-Key fallback switch. The operator can
adjust necessary reversible settings through the normal application API and
restore them after acceptance.

## What execution does

Each selected case uses its exact existing subscription:

- Claude Code: claude-haiku-5-5.
- Codex: gpt-6-luna.

It creates one temporary fixed Agent Profile, selects the corresponding
Coordinator composer subscription, and calls coordinator.sendCoordinatorMessage
through /api/rpc with a cloud destination and the Profile ID. The task requests a
tiny text Artifact with exact bytes, plus the ordinary independent review and
verify stages. Because the temporary Profile is the only enabled Profile, the
automatic checks also select that fixed subscription. Every native run is checked
against its frozen identity, model, harness, credential type, cloud owner and
Profile receipt.

The request includes a fresh W3C traceparent. Its trace ID is reported as a
client-supplied parent; backendObserved remains false until the operator finds it
in PostHog/APM. The driver sends no invented frontend session or replay ID.

Progress reads follow authenticated WebSocket invalidations. The socket renews
its normal five-minute connection capability and uses keepalive pings; it does
not periodically poll application data. If push disconnects, the case stops.

One execute, one review and one verify run are allowed per case. No message,
model failure or task creation is retried by the driver. The first observed
extra attempt triggers cancellation. This is an observation-based limit, not a
server-side atomic spending fence: the API exposes neither a synchronous
per-task native-attempt cap nor a hard dollar budget. A server-side continuation
can start before its notification is read. The report explicitly records that
limit. Deadlines, fixed small subscription models and no resubmission bound the
driver's work.

## Evidence and cleanup

production-run-observability-report/report.json contains only safe opaque IDs,
the deployment SHA, timestamps, model/harness enums, stages/statuses, Artifact
byte count/hash, cleanup results and the expected trace parent. Raw prompts,
replies, tool contents, cookies, passwords, capability tickets, account email,
provider responses and exception messages never enter the report or console.

Task, thread and Artifact receipts are retained for PostHog correlation. On
completion or failure the driver cancels its own still-live Factory task and
stops its own threads, archives its temporary Profile only after work is quiet,
and restores the original explicit composer choice. It compares that setting
before restoration and does not overwrite a concurrent edit. The current API
offers no atomic model-choice revision; this is an optimistic comparison.
A shared Coordinator is stopped only while all new human messages still belong
to the exact submitted fixture. Incomplete cleanup is reported as blocked and
halts later cases. The driver's authentication session is closed in finally.

A deterministic Profile/submission ID per deployment and model prevents a
workflow rerun from silently repeating paid work. An uncertain POST response is
reconciled through the normal reads and cleanup; the POST is never resent.

## Result meanings

- ready: all selected preflight cases passed; no model task was submitted.
- runtime_verified: actual frozen native receipts, distinct execute/review/verify
  runs, passed checks and downloaded Artifact bytes were verified.
- blocked: a gate, execution or cleanup failed; its closed code identifies the
  next investigation.

Successful statuses exit 0; blocked exits 1. A one-model invocation proves only
that selected model. The required acceptance uses both cases.

runtime_verified does not assert that PostHog has ingested the data or that a
browser Session Replay exists. Those fields remain false. Use the retained
trace/run/task/workflow IDs for the independent PostHog trace, AI generation,
Logs and browser Replay checks. A fixture-only unit test is not production
acceptance.
