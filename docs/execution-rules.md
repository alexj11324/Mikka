# Explicit execution settings (#490, #537)

Backend only. The settings UI is maintained separately in #529 and its dependent PRs.

## Frontend contract

`app/actions/execution-settings.ts` derives owner/workspace from the authenticated
session. The existing action names remain:

- `listExecutionRules()`: ordered label rules followed by a persisted default with
  public `id: 'default'`, `label: null`, and position `2147483647`.
- `createExecutionRule(value)` and `updateExecutionRule(id, value)`: fields are
  `label`, `place` (owned local device UUID or `cloud`), `harness`
  (`claude_code`, `codex`, `cursor`), and `model` (reported model or slot).
  `updateExecutionRule('default', value)` saves the default in `execution_rules`;
  its label is always null. A label is required for other rules.
- `deleteExecutionRule(id)` and `reorderExecutionRules(ids)` still reject the
  default. Reorder requires the exact set of editable UUIDs.
- `listExecutionPlaces()`: devices, `deviceType`, enabled/online state and
  `harnesses`, plus the cloud choice. `HarnessInfo` now optionally includes
  `modelSlots: {slot, model, name}[]` and `defaultModelSlot`. Persist the slot;
  show only its resolved `name`, without an alias prefix. Legacy `models` stays
  available. Cloud models come from connected subscription bindings.
- `getExecutionFallbacks()` and `updateExecutionFallbacks(value)`: per-person
  `{whenDeviceOffline: 'wait' | 'cloud', whenQuotaExhausted: 'stop' | 'switchAccount'}`.
  Both fields are required when updating. Defaults are `wait` and `stop`.
- `listBotModels()`, `getBotModel(botId)`, `setBotModel(botId, bindingId)`:
  null Bot means Coordinator. A binding must be explicit; null/`auto` choices
  are refused. First access persists the first connected binding when none is
  saved. A saved unavailable binding is retained and execution refuses it.

`auto` in any execution field, or clearing a Bot model, returns the stable
`executionAutoNotAllowed` action error. Existing field errors remain
`executionPlaceInvalid`, `executionHarnessUnavailable`, `executionModelUnknown`;
ordering/ownership failures retain their existing codes.

## Initial choice and migration

Initial values are persisted on the first settings read or issue dispatch,
under the same advisory transaction lock as CRUD. Concurrent reads cannot create
multiple defaults or overwrite a person's selection.

A connected Claude subscription prefers Claude Code and its reported `opus`
slot, first on an enabled online server, then another enabled online device.
Otherwise a connected Codex subscription prefers Codex's reported default slot.
Without a matching local install, a connected cloud binding supplies an explicit
cloud choice. No server model-name constants or guessed model names are used.
When no usable report/binding exists, return `executionModelUnknown` rather than
inventing an automatic choice; redetect/connect an account first.

`20261031001500_explicit_execution.sql` is idempotent: it makes the label nullable,
adds a single-default unique index, removes auto column defaults, guards new
writes, and adds `user.executionFallbacks`. Existing auto rows with available owner reports/bindings are converted during
deployment. Rows awaiting discovery are retried on first scope read/dispatch,
in that same transaction. Actual metadata is required rather than guessing
a model during deployment. Old auto-place rules preserve
online-device/harness preference. Explicit fields are preserved. If metadata is
unavailable the read fails and the transaction rolls back; retry after discovery.
Repeated reads leave already concrete rows unchanged. No new table is introduced.

## Discovery and execution

Claude Code discovery uses the Agent SDK initialization `supportedModels()`
metadata, including `resolvedModel`, without sending a prompt. Model remaps from
CLI settings and the non-secret `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`
identifiers are retained. No credentials are added to the discovery environment.
Codex uses app-server `initialize` / `model/list`; its `isDefault` row supplies
the internal `default` slot. Cursor uses `--list-models`. Discovery failures
advertise no catalogue; they never fabricate one. Slot resolution follows the
latest heartbeat report at each new dispatch; in-flight snapshots remain frozen.

First matching label by position wins, otherwise the saved default. Explicit
harness/model values reach the existing local/cloud admission and subscription
checks. With `wait`, offline/disabled devices remain pinned and queued; takeover
and offline expiry do not reroute them. `cloud` explicitly routes to cloud using
the last reported resolved model, retaining runtime and account authorization.
Device-specific source-event authorization still cannot be redirected to cloud.

Bot quota `stop` propagates the exhaustion error. `switchAccount` only tries
another connected account of the same owner/workspace, route and model. Each
candidate is independently bound to the consumer and reauthorized for epoch,
workspace, connection and quota. No paid provider fallback, model substitution,
or retry of a partially emitted generation is introduced. Unavailable accounts,
unknown quota and authorization errors do not trigger switching.

## Other existing handoff actions (#539)

`listWorkspaceIssueLabels(workspaceId?)` returns `{name,color}[]` for visible,
nondeleted workspace issues via their team links. Personal issues are excluded;
names are deduplicated case-insensitively.

Bot model options remain deduplicated by `(connectionId,modelId)` and include
`bindingId`, `consumerId`, `modelId`, `route`, `connectionId`, `provider`,
`accountLabel`, `plan`. `getBotModel()` returns the visible option corresponding
to a saved copied binding; execution retains the original stored binding.
`refreshBotModels(connectionId,workspaceId?)` refreshes an owner/workspace/epoch
scoped catalogue and returns those options. Provider failures return
`executionAccountUnavailable` without exposing response bodies.

`redetectDevice(deviceId)` enqueues owner-local discovery;
`getRedetectDeviceStatus(commandId,workspaceId?)` returns
`{commandId,status:'pending'|'completed'|'failed',completedAt,error}`.
Only the daemon acknowledgement completes the command.

## Verification and risk

The previous automatic default affected every owner without a saved rule
(occurrence 10/10, impact 7/10): an unlabeled dispatch silently selected its
execution place/harness/model. Regression tests cover explicit defaults and
rejection, idempotent scope migration, concurrency, owner/workspace boundaries,
subscription preference, slot mappings, offline decisions and quota decisions.
Database tests run against an isolated loopback `mikka_e2e` schema; discovery
and generation policy tests use fixtures without real model calls.
