# Issue #1512 production run driver

The driver uses the existing ordinary account login and normal browser API
transport. Credentials stay in the GitHub Actions runner. It creates no tokens,
logs into no model provider, changes no workflow and makes no direct database
writes.

## Account and workspace scope

This driver uses `ACME_DEMO_EMAIL` / `ACME_DEMO_PASSWORD` from Infisical `prod:/`
and verifies the account's admin-owned personal workspace. This is the account
explicitly authorized for [issue #1512](https://github.com/alexj11324/Mikka/issues/1512).
Its receipts prove only that account's selected workspace and own subscriptions;
they do not establish shared-team behavior. Other production acceptance uses
the shared SMOKE account in the Acme Inc. workspace under
[the acceptance guide](../../docs/acceptance.md#shared-production-acceptance-workspace).
The driver has not been migrated to that shared-team fixture. Do not substitute
an account, workspace or subscription within an existing case.

## Commands

Node 24 is sufficient for the driver and manual-browser helper; no package
installation is required for those paths. The optional workflow runner browser
uses the repository's locked Playwright 1.64.1 and its matching Chromium.

    node --test scripts/acceptance/run-observability.test.mjs
    node scripts/acceptance/run-observability.mjs
    node scripts/acceptance/run-observability.mjs --execute
    node scripts/acceptance/run-observability.mjs --execute --prepare
    MIKKA_OBSERVABILITY_MODEL_CASE=claude node scripts/acceptance/run-observability.mjs --execute --prepare --browser-submit

The second command checks business readiness without submitting model work.
Sign-in and sign-out create and close its own authentication session. The normal
model-order API can discover and persist a missing subscription catalogue; that
directory discovery performs no inference. The third command is the explicit
execution boundary; without that flag it submits no messages or tasks.
Both optional flags require --execute. --browser-submit also requires exactly
one selected case, claude or codex; all is rejected before authentication.

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

Before reading Coordinator, the driver uses the workspace response's choices to
identify exactly one personal workspace. It verifies that the signed-in account
is its admin and sole member, with active admin membership. If the default is a
team, an explicit workspace GET verifies the personal candidate first; the normal
workspace.switchWorkspace action then changes only this new login session's
cookie. A GET without a workspace query must confirm that selection before any
Coordinator reads or preparation. Missing or ambiguous choices, mismatched members
and a failed switch/readback block the run. The driver calls no workspace creation
API, never selects a team and leaves the independent browser's cookies untouched.
Normal sign-out cleans up this session. The report records only workspaceId and the closed
workspaceSelection value (current_personal or switched_personal), never names or
email addresses. In browser mode, select the reported workspace separately.

| Code | Required state |
| --- | --- |
| build_mismatch | Production must serve the supplied immutable SHA before and throughout the case |
| workspace_missing | The signed-in account must own an admin personal workspace |
| workspace_busy | Workspace bot runs, owner threads and existing Factory tasks must be idle/terminal |
| task_inventory_truncated / task_inventory_changed | The finite cursor scan must complete within 100 pages of 50 tasks, with no repeated IDs/cursors or changed first page |
| coordinator_disabled / coordinator_busy | Coordinator enabled, no working turn or pending human input |
| model_not_restorable | Existing composer choice explicitly saved, available and present in its menu, with no current fallback |
| paid_fallback_enabled | The existing subscription-to-API-Key fallback setting must be off |
| profiles_active | No existing enabled Agent Profiles in this owner/workspace |
| source_missing / source_ambiguous / source_blocked | Exactly one usable owned subscription source for the exact required model |
| cloud_unavailable | Existing owner cloud configuration and model support ready |
| live_unavailable | Authenticated live channel exposes bot_chat, run, factory_task and factory_issue invalidations |
| previous_fixture | This deployment/model has already created its deterministic Profile; never silently spend again |
| owner_busy | Optional preparation/restoration requires all visible owner runs across workspaces to be terminal |
| preparation_conflict / preparation_restore_failed | Optional preparation/restoration must retain its acknowledged version and values |

The task inventory follows the existing /api/issues/search cursor API, preserving
the server's opaque cursor. It reads every page, then checks the first page once
for concurrent changes. This removes the old mobile endpoint's 100-row cap without
introducing periodic application polling.

### Optional temporary preparation

By default, paid_fallback_enabled and profiles_active remain read-only blockers.
--prepare temporarily disables subscription-to-API-Key fallback and existing
enabled Profiles through normal application APIs. It validates the other gates
first; in all mode, an unavailable case does not prevent an available case from
running. chosen=false with preferenceState=absent uses temporary-if-absent;
cleanup uses revision-checked restore-implicit. Global model order is never changed.

Before each preparation or restoration write, both existing owner-wide run
readers must report only terminal runs, including other workspaces. Each exposes
at most 200 rows in its 30-day window; the report claims only this visible scope.
The current workspace's bots, threads and full Factory inventory must also be
quiet before preparation.

Full Profile snapshots stay only in RAM. Disabling and restoring a Profile use
the server's version CAS. Restoration also compares its last acknowledged digest
and definition; an intervening edit is preserved. Definitions return to their
prior values, while version counters advance normally. The boolean fallback API
has no CAS, so its restoration uses an immediate comparison with the acknowledged
value and an owner-idle check. It cannot detect an intervening boolean ABA edit.
Lost mutation responses are not guessed or resent. A failed/concurrent restoration
returns blocked and closed error codes; report.preparation contains counts and
results, never snapshots or Profile contents. Process termination that prevents
finally from running cannot guarantee restoration.

## What execution does

Each selected case uses its exact existing subscription:

- Claude Code: claude-haiku-5-5.
- Codex: gpt-6-luna.

API execution creates one temporary fixed Agent Profile, selects the corresponding
Coordinator composer subscription, and calls coordinator.sendCoordinatorMessage
through /api/rpc with a cloud destination and the Profile ID. The task requests a
tiny text Artifact with exact bytes, plus the ordinary independent review and
normal delivery acceptance. The frozen Factory flowVersion controls the checks:
v2 requires execute and one independent review; historical tasks also require
verify. Because the temporary Profile is the only enabled Profile, the
automatic checks also select that fixed subscription. Every native run is checked
against its frozen identity, model, harness, credential type, cloud owner and
Profile receipt.

Only a no-repository deliverable candidate is eligible. Once its required native
stages have passed for the current candidate and request epoch, the driver
downloads the exact Artifact bytes and uses the normal Owner approval API once.
It requires the accepted response and the corresponding passed approval attempt
with its deliverable acceptance receipt. Pending approval, a missing/failed check,
or a missing receipt is never reported as completed work. Repository candidates
are refused before approval; no merge or publication is requested.

The request includes a fresh W3C traceparent. Its trace ID is reported as a
client-supplied parent; backendObserved remains false until the operator finds it
in PostHog/APM. The driver sends no invented frontend session or replay ID.

### Real browser submission

--browser-submit performs the same preparation and live observation, then emits
one immediately flushed JSON line with type=mikka_observability_browser_ready.
It contains the revision, case, workspaceId, botId, profileId, marker, model,
harness, cloud destination, expiresAt, and the code-generated input and Artifact
bytes. This fixed acceptance input is deliberately public fixture text; it is
not copied from account messages or settings. The final report omits the text.

For the CLI's manual-browser path, use an independently signed-in browser with
the official Cloud backend selected,
then select the reported workspace. Confirm the backend selection separately:
`/api/version` always identifies the official browser shell, including when its
business requests target a selected self-hosted backend. Refresh the page to the
deployed revision, then open New task outside a project page.
Choose its Coordinator, explicitly choose Mikka Cloud,
select the temporary Profile named by marker, paste input unchanged, and click
Create task once before expiresAt. The deadline includes this waiting time. The driver
does not inject a browser cookie or invoke an API message submission in this mode.

The driver accepts only one exact new human message after its baseline, using the
current English or Chinese New task + Cloud wrapper from the application's
translation files. Extra text, project context, unrelated human activity or a
duplicate message blocks the case. It records the actual persisted chat position
and locale, then validates the same task/identity/Profile/native-run receipts and
Artifact as API mode. A late click is reconciled during cleanup; never send after
the displayed deadline. Unobserved ownership or incomplete cleanup remains blocked.

#### Optional runner Chromium actor

In the existing main-only workflow, explicit execute plus browser-submit=true
and a single model case selects the runner actor. There is no additional dispatch
input. The workflow installs pnpm 10.34.3, the frozen dependency lock and Playwright
1.64.1's Chromium before loading the two existing account secrets. Preflight and
API execution do not install or launch Chromium. The main/repository guard,
expected-deployment-sha == GITHUB_SHA check, actual deployed-version gate and
existing Infisical identity are unchanged.

The helper consumes --runner-browser itself and never forwards it to the driver.
It requires --execute, --browser-submit, one case, a real GitHub Actions
workflow_dispatch context, the exact main ref/repository and the matching source SHA. Without this flag, both the CLI browser
path and the helper's existing manual-ready comment remain available.

After validating the exact ready object against fixtureTask, the helper posts
a runner-automatic progress message that explicitly says not to submit manually.
It starts one independent browser context, signs in through the ordinary email
form, verifies the current account and exact personal workspace in RAM, selects
that workspace through the existing menu, and opens New task outside project
context. It selects Coordinator, Mikka Cloud and the unique marker Profile,
fills the generated input and clicks Create task once. It neither transfers the
driver's cookie jar nor sends a task/model request through a separate API.
A refusal, timeout, ambiguous selection or uncertain click never retries the
submission. The original driver still observes the actual persisted UI message
and verifies all task, Factory, native-run and Artifact evidence.

The actor explicitly admits its real automation through PostHog's public
`opt_out_useragent_filter` option for this fresh browser context. Before its
first page, it installs a non-persistent marker only on the official app's
top-level documents. An unexpired marker at initialization enables this option;
the ten-minute bound does not reset a running SDK. Closing the owned context
ends that instance. Ordinary visitor instances keep the default bot filter.
The browser retains its actual user agent and automation signals, and the
sanitizer preserves only the SDK's `bot` or `browser` classification. Replay
records the actual automated UI actions under the unchanged masking policy.

Before the paid click, the actor checks that the active PostHog session has
loaded its SDK, started recording and observed a sanitized snapshot. It reads
the session again immediately before submission. It does not force recording,
allocate a session or change consent. The receipt keeps `uploadAcknowledged`
unknown. Verify upload and playback through separate PostHog readback.

The actor uses a clean context and the fixed official origin; ordinary responses
verify its selected backend instead of inferring it from the shell version alone.
The browser process receives only its required environment, without acceptance
credentials or GitHub tokens. Credentials are used by the runner's form fill and
are never persisted as storageState. Playwright tracing, screenshots, videos,
HAR files, page text, console/error text and raw request/response logs are not
acceptance artifacts.

Driver termination aborts browser preparation, and browser failure requests the
driver's normal SIGTERM cleanup. The helper keeps draining stdout while the actor
starts and waits for both owned lifecycles. Browser cleanup uses its own bounded
deadline after the business signal is aborted. It first closes the owned page to
stop pending UI actions, then uses the retained context for normal sign-out and
anonymous-session readback, and closes the context and browser. Cleanup is idempotent; any
failure makes the workflow fail even if the driver returned zero. A process kill
that prevents finally from running still cannot guarantee cleanup.

production-run-observability-report/browser-actor.receipt.json contains only
checked fixture IDs, closed stages/counts and cleanup results. Its independent
UI submission receipt does not assert PostHog ingestion or Replay availability.
The workflow uploads only that receipt and the existing report.json. Existing
PostHog export and actual Replay readback remain separate evidence steps.

Browser mode does not create requestTrace, traceparent, session IDs or replay IDs.
Its real browser request supplies those through normal application instrumentation.
Use the retained task/run/workflow IDs to find and verify that same browser trace
and Replay independently. browserReplayVerified remains false in this driver.
Run the other required model separately, with browser-submit=true when collecting
its browser correlation evidence too.

Progress reads follow authenticated WebSocket invalidations. The socket renews
its normal five-minute connection capability and uses keepalive pings; it does
not periodically poll application data. If push disconnects, the case stops.

One execute and one review run are allowed for v2; historical tasks also allow
one verify run. No message, model failure, task creation or approval request is
retried by the driver. The first observed
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
The browser-ready line is the sole exception for locally generated fixture input,
not account content.

Task, thread and Artifact receipts are retained for PostHog correlation. On
completion or failure the driver cancels its own unfinished Factory task and
stops its own active threads. A genuinely accepted deliverable remains accepted.
Once its runs and Factory task are terminal, it ends each of those runs' machines
through the normal API, including machines left by successful runs. `cleanup.machines`
records `ended` only for HTTP 200 with the exact run ID and state, or `not_created`
after HTTP 404 plus a fresh owned terminal run and an explicit null machine read.
Reading state `ended` alone is not a kill receipt. Any failed end keeps
`ownMachinesEnded` false and cleanup incomplete; other owned machines are still closed.
The driver archives its temporary Profile only after work is quiet,
and restores the original explicit composer choice. It compares that setting
before restoration and does not overwrite a concurrent edit. The current API
offers no atomic model-choice revision; this is an optimistic comparison.
A shared Coordinator is stopped only while all new human messages still belong
to the exact submitted fixture. Incomplete cleanup is reported as blocked and
halts later cases. The driver's authentication session is closed in finally.

A deterministic Profile ID (and API submission ID) per deployment and model prevents a
workflow rerun from silently repeating paid work. An uncertain POST response is
reconciled through the normal reads and cleanup; the POST is never resent.
In browser mode the application's real client generates the submission ID; the
driver neither overrides nor fabricates it. A created Profile still prevents an
automatic rerun, including after a browser-wait timeout.

## Result meanings

- ready: all selected preflight cases passed; no model task was submitted.
- runtime_verified: actual frozen native receipts, distinct required native runs
  for that Factory version, passed current-epoch checks, downloaded Artifact bytes
  and the normal deliverable acceptance receipt were verified.
- blocked: a gate, execution or cleanup failed; its closed code identifies the
  next investigation.

Successful statuses exit 0; blocked exits 1. A one-model invocation proves only
that selected model. The required acceptance uses both cases.

runtime_verified does not assert that PostHog has ingested the data or that a
browser Session Replay exists. Those fields remain false. Use the retained
trace/run/task/workflow IDs for the independent PostHog trace, AI generation,
Logs and browser Replay checks. A fixture-only unit test is not production
acceptance.
