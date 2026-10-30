# Execution settings backend (#490)

No page, component, Figma or other frontend change is included.

## Storage and scope

`20261030200610_execution_rules.sql` is idempotent. `execution_rules` belongs to
an owner and workspace, matching `bots` and the settings workspace boundary.
Devices remain personal infrastructure: a rule can reference only its owner's
local device. Positions are serialized per settings scope and use a deferred
unique constraint so reorder is atomic. The all-auto default is a virtual row
with id `default`; CRUD and reorder cannot change or delete it.

`bot_model_choices` records an optional connected subscription binding per Bot,
or `coordinator` for the Coordinator. Clearing a choice selects automatically
from connected bindings. Models come from the owner's connected, current-epoch
account bindings; this API does not claim to enumerate models that an account
has never reported or bound. Choosing a model already used by another owned Bot
copies its non-secret binding reference to the target Bot. Immutable execution
snapshots retain the selected binding and continue to check owner, workspace,
consumer, connection revision and connection state on every model call.

Bot workflows use AI SDK subscription execution, including when versioned
Agent Kit definitions are disabled. No new model ids or model environment
variables are introduced. A missing connected model refuses execution.

Without browser cookies, the Coordinator uses the owner's first active workspace
in creation order, matching the settings fallback. Named Bots use their exact
workspace. Workspace authorization is checked before resolving either target.

## Resolution and execution

`resolveExecution(labels, rules, devices)` checks label rules by ascending
position. The first match wins; otherwise it uses the fixed default. Auto prefers
an enabled online local device with a compatible installed harness and then
selects cloud. Explicit devices never fall back. Their runs stay queued on the
same device and the owner read API includes `waitFor` while it is offline.
Pinned retries are excluded from device takeover and offline queue expiry.

Coordinator `dispatch_run` resolves these settings before entering existing local
admission or cloud queue/claim gates. Device-specific source-event authorization
cannot be redirected to cloud. Cloud dispatch retains the requested repository.
The Coordinator can use an existing owned cloud Bot execution environment in
the same workspace while retaining Coordinator attribution. Cloud execution
requires the existing configured E2B runtime and subscription binding; missing
runtime/account prerequisites return an unavailable result, never a success.

The frozen worker snapshot marks automatic versus explicit CLI model selection.
New automatic assignments omit `model`; explicit assignments carry only the
chosen model. Claude's SDK and Codex's app-server receive an explicit model only
in the latter case; Cursor adds `--model` only in that case. The subscription
broker honors that same run-frozen selection. Historical snapshots without the
marker retain their binding model. Owner, active run, lease, quota, route and
credential isolation checks remain in both TypeScript and Go.

## API

`app/actions/execution-settings.ts` derives user and workspace from the session:

- `listExecutionRules`, `createExecutionRule`, `updateExecutionRule`,
  `deleteExecutionRule`, `reorderExecutionRules`.
- `listExecutionPlaces`: owner devices, type, enabled/online state, installed
  harnesses and optional per-harness models, plus the cloud option. The frontend
  supplies its localized cloud label.
- `listBotModels`, `getBotModel`, `setBotModel`: `null` Bot means Coordinator;
  `null` binding means automatic selection.
- `redetectDevice`: owner-local-device only.

Mutations validate ids and ownership. Rule ordering requires the exact current
set of editable ids; missing, duplicate, foreign and default ids are rejected.

## Daemon discovery

`HarnessInfo.models`, `deviceType` and heartbeat device-command acknowledgements are optional,
so older daemon payloads remain valid.

- Codex: installed `codex app-server`, JSON-RPC `initialize` followed by
  `model/list`; report the CLI account's returned model identifiers.
- Cursor: installed `cursor-agent` or `agent`, `--list-models`; parse returned
  identifiers without supplying a built-in list.
- Claude Code: no CLI list operation is used; report no models, leaving only
  automatic selection. Failed or unsupported discovery also reports none.

The shared device-management command channel from #491 delivers `redetect` by
command id in the heartbeat response. The daemon reruns detection and sends an
immediate follow-up heartbeat with its refreshed harness/model report and the
completed command id. Normal heartbeats cannot consume an unacknowledged command.

## Frontend handoff (#539)

These additions are backend contracts; they do not implement #537's explicit
initial choices or remove the existing automatic options.

- `listWorkspaceIssueLabels(workspaceId?)` returns `{name, color}[]` for
  nondeleted workspace issues visible through the current workspace's team
  links. Personal issues have no workspace association and are excluded.
  `color` uses the existing issue-label palette. Duplicate names are folded
  case-insensitively; the newest visible issue supplies its spelling and color.
- `listBotModels()` returns one row per `(connectionId, modelId)`, with
  `bindingId`, `consumerId`, `modelId`, `route`, `connectionId`, `provider`,
  `accountLabel`, and `plan`. Label and plan are nullable when the connection
  has not reported them. The account label is the existing connection label;
  the plan comes from its last quota snapshot. Saved Bot-specific binding ids
  remain accepted even when another copy represents the model in the list.
  `getBotModel()` returns the visible option id for an available saved model;
  internal execution reads keep their original stored binding id.
- `refreshBotModels(connectionId, workspaceId?)` asks that connected account's
  provider for its current model list and returns matching model options in the
  same shape. It creates idempotent catalogue bindings in the existing
  `byos_bindings` table; choosing one still copies its binding for the target
  Bot. A nullable `byos_connections.modelCatalog` snapshot records the last
  successful catalogue and its revision; rereading the model list excludes
  models removed by that provider, including when its current list is empty.
  Existing bindings are retained for saved choices and run snapshots. The
  idempotent `20261030233002_byos_model_catalog.sql` migration adds this column.
  Discovery and storage both check the account owner, workspace and epoch;
  a disconnect/reconnect during discovery rejects the refresh. Provider errors
  become `executionAccountUnavailable` rather than exposing response bodies.
- `getRedetectDeviceStatus(commandId, workspaceId?)` reads the existing receipt:
  `{commandId, status: 'pending' | 'completed' | 'failed', completedAt, error}`.
  Only the device owner can read a local, nonremoved device's redetect command.
  Completion is the daemon's acknowledgement; polling does not complete it.

`ExecutionSettings` now throws `ActionFailureError` for expected failures:
`executionPlaceInvalid`, `executionHarnessUnavailable`, `executionModelUnknown`,
`executionRuleNotFound`, `executionRuleOrderInvalid`,
`executionCommandNotFound`, `executionAccountUnavailable`, and `botNotFound`.
Malformed remaining rule fields use the existing `validationGeneric` code.
Explicit device rules check installed harnesses and the device's reported
model list. Cloud/automatic-place explicit models must belong to a connected
account binding for the selected harness. Automatic model selection retains
its current behavior until #537.
