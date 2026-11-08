# Enabled-model settings API (#1539)

All arguments are positional. Both browser RPC and desktop RPC expose these
registered server actions. Each action authenticates the session and loads
normal workspace membership before touching the signed-in owner's sources.
A shared credential can be used by teammates; only its owner can change it.

| Action | Arguments | Result |
| --- | --- | --- |
| `enabled-models.getEnabledModels` | workspaceId | `{sources: EnabledModelsSource[]}` |
| `enabled-models.setModelEnabled` | workspaceId, sourceId, modelId, enabled | updated source |
| `enabled-models.setAllModelsEnabled` | workspaceId, sourceId, enabled | updated source |
| `enabled-models.setAutoEnable` | workspaceId, subscriptionId, enabled | updated source |
| `enabled-models.markModelsSeen` | workspaceId, sourceId | updated source |

Normal settings action errors use `{error: code}`. UUIDs, model lengths and
booleans are validated. A source/model not owned or not in its catalogue refuses
as `executionModelUnknown`; API keys cannot acquire arbitrary unreported models.
An API key with no reported models offers no selectable models.

```ts
interface EnabledModelsSource {
  id: string // subscription/key UUID, or 'hosted'
  kind: 'subscription' | 'api_key' | 'hosted'
  models: {id: string; enabled: boolean; fresh: boolean}[] // raw model IDs
  enabledCount: number
  total: number
  freshCount: number
  autoEnable?: boolean // subscription only
  refreshedAt: string | null
  refreshError: 'invalid' | 'unavailable' | null
}
```

The existing `model_settings` live invalidation refreshes both settings and bot
pickers after the transaction commits, including authorized shared users.
Display names and family grouping remain the frontend's existing responsibility.

Subscription settings are account-scoped, just like their credential: a toggle
applies wherever the owner shares that source. Automatic release selection
reuses `latestDefaultCandidates`, independently within each model family/tier.
Explicit on/off overrides survive catalogue refreshes and temporary model
absence. Turning automatic enablement off keeps existing choices and leaves
new models off. Legacy migrations retain all previously available models as
explicit on choices, prioritizing continuity over retiring old releases.

Existing API-key catalogue models remain enabled. A newly reported model on
refresh is off/fresh; opening the panel clears fresh without enabling it, and
an explicit enable also clears fresh. Refresh and toggle serialize on the same
credential row. Failed provider refresh retains the previous catalogue and its last successful
refresh time. Toggling or marking models seen does not advance that time;
historical catalogue timestamps that were never recorded return null.

The hosted source has one model: the installation's configured default raw ID,
or Mikka's existing default ID for its managed route. An active cloud model
binding takes precedence over a configured local provider, matching the
existing default-model resolver. It defaults on. A disabled
hosted default cannot start a new bot turn; the usual preferred available source
is tried instead, and no enabled source produces the existing model error.
Internal Decision/title/background infrastructure is not a selectable source.

Settings mutations never cancel or rewrite frozen runs. Disabling removes
matching preferred entries and filters old saved bot choices on the next turn.
A source disappearing due to provider failure remains distinguishable from an
explicit disable in the ordinary preferred-model view.

The #1539 follow-up makes credentials the sole model catalogue. Devices check
participation, presence, Agent installation and subscription injection, never
exact CLI model IDs or slots. `OrderView.deviceModels` and device
`modelNotReported`/`modelEvidence` projections are removed. An older model
listed by an authorized enabled credential can run on an eligible device even
when the device reports only current shortcuts. Cloud image provenance and
installed-Agent checks remain; the image's model list is not a model gate.

The native runner still requires the exact prepared credential's model and
owner, route and lease checks. It no longer probes the CLI for model admission.
A structured native provider model refusal enters the existing per-task
ordered continuation as `ProviderFailure {kind:'model', retryable:false,
code:...}`. It neither marks the model/source unavailable globally nor changes
the catalogue. Generic tool errors and bare HTTP 404s cannot trigger this path.
Explicitly pinned model choices retain their existing refusal semantics;
preference-driven tasks try the next authorized entry.
