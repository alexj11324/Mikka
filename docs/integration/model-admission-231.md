# Model admission (#231)

The workspace policy row owns `model_admission`; there is no second policy
registry or execution epoch. Policy contents are exact model/serving-provider
allowlists, fixed Gateway/subscription transports, optional principal IDs and explicit data
region requirements. Unknown data region is not evidence of regional routing.

The initial store uses the existing central workspace membership lease and
write transaction. Only an active administrator may publish a policy. Writes
compare the previous content revision and append an allowlisted existing audit
row in the same application transaction. A different workspace is unchanged.
No credentials, rule contents or prompt text enter policy audit metadata.

The hosted-model consumer rechecks before accounting and before sending each
generate/stream call, including SDK retries. Managed calls use the fixed Gateway
SDK transport with `redirect: error`. Provider order, fallback models and BYOK
options from the caller cannot broaden the published route. The first contract
allows one physical serving provider per model, so Gateway cannot silently
fail over to another provider. An injected model
cannot assert that it uses the trusted endpoint. The current balance admission
and actual-cost settlement remain the existing billing store's responsibility;
this consumer does not estimate or prepay a maximum inference cost.

The existing private subscription worker fixes Codex requests to
`https://chatgpt.com/backend-api/codex/responses` and Claude requests to
`https://api.anthropic.com/v1/messages` (native protocol also permits its fixed
`?beta=true` variant). Policies can now authorize these exact existing
`openai-subscription` / `anthropic-subscription` transports, physical provider
and model. They still report `unknown` data region; US/EU-only rules refuse.
No new endpoint, proxy, credential or subscription eligibility is introduced.

Frozen BYOS models and the actual service transport recheck current principal,
workspace and policy before each SDK call. Account fallback keeps the same
model/route and re-enters this boundary. Native claim permits an existing bound
broker only; each native HTTP request rechecks its live owner/device/run/binding,
actual model/path and all current Bot/task workspace policies. The production
hosted CLI receives a placeholder and its task-bound broker socket, never a
provider bearer. The Go worker retains fixed destinations, credential filtering,
redirect refusal and its per-chunk runtime/quota checks.

Direct native CLI and the legacy in-process raw-credential launcher still
refuse configured model policies. Initial policy installation cannot claim to
recall earlier unmanaged native credentials, so it requires those runs to end.
Existing policy updates/revocation remain available while controlled work is
live; its following calls consult the new policy. This proves the supported
broker route, not arbitrary native model aliases: the existing runner/worker
still require the frozen binding model for fully working native execution.

`/api/workspaces/:workspaceId/model-admission` reads a current member's policy;
same-origin cookie-authenticated writes pass through the same guarded admin
store. Request bodies are bounded to 16 KiB and cannot choose a principal.
Coordinator triage, group routing/replies, attention, hosted workflows and
proactive consumers carry server-owned principal/workspace context. Web child
planning uses the same hosted-model boundary; its separate semantic judgment
has the actor's scope too. Existing evaluation and default Factory recovery
consumers resolve their stored task/owner scope before inference.

A Decision Gateway API key without billing scope now sends no request. Scoped
Decision calls check current balance and organization policy before accounting,
then recheck policy before sending, with redirects disabled. The old Decision
transport does not prove provider routing, so a configured organization policy
refuses that transport. This is not positive managed Decision acceptance.

A policy/alert/abort failure after admission but before any provider call
settles at known zero cost. A failure after transport starts keeps the existing
unknown-receipt behavior. A real PostgreSQL plus loopback-HTTP test verifies that
zero-cost policy refusal leaves the positive balance and next-call slot usable.
These source/DB/transport checks are not completion of #231.

Validation: cloud Linux, PG17 on loopback port 55599, isolated database
`mikka_admission_closeout_e2e`, all 155 migrations. Contract tests: 3 passed.
Real PostgreSQL store tests: 7 passed, zero skips, including refusal to publish
over a live native run and current call audits. Source model-wrapper tests: 6;
actual Gateway SDK with a real loopback HTTP 307: 1; HTTP handler: 1; claim: 15;
subscription snapshots: 8. All passed. Framework/provider fixtures are explicit
and do not represent live external model requests. Logs use the
`/tmp/mikka-admission-` prefix, including `store-wired.log`, `model-unit.log`,
`redirect.log`, `http-unit.log`, `claim.log` and `subscription.log`. Scoped
Decision/child tests: 26 passed; existing AgentKit model suite: 52 passed. Group
and Factory source checks: 11 passed with one pre-existing Actions-only PG
case skipped locally; no Actions identity was fabricated. Postpayment plus
zero-provider-call revocation tests: 2 passed against real PG and loopback HTTP.

Additional validation on `3e2135e3` plus this patch: real existing PG17 on
loopback 55599 (`mikka_admission_closeout_e2e`), actual OpenAI-compatible SDK
parser and loopback HTTP exercise permitted Codex/Claude BYOS models, a denied
second workspace, cached-model revocation/region/abort, native HTTP permit and
deny across Bot/task workspaces, live revocation, membership removal, STOP,
model/path substitution and legacy raw-launch rejection. The private worker
boundary is an explicit fixture; Go was source-reviewed, not compiled or
executed in this environment. Existing daemon broker/IPC tests are separate
evidence and do not represent real provider inference. Logs:
`/tmp/mikka231-subscription-pg.log`, `daemon-broker.log`, `modelsuite.log`,
`claim-fallback.log`, `admission.log`, `mvp.log`, `typecheck.log` and `lint.log`
(all suffixes use the same `/tmp/mikka231-` prefix).

Outstanding acceptance still includes live provider inference, a live
child/fallback model request and the main-site user path. A fixture provider,
database test or model name cannot close those requirements. There is no
verified regional provider capability in the current transports, so requests
requiring a known region remain refused rather than being labelled compliant.

Risk estimate: policy bypass across principal/workspace or provider routes is
occurrence 6 × impact 8 = 48. The concrete availability gap repaired here was
that every configured policy rejected the existing fixed subscription routes.
The positive-path tests retain the denial, live-revocation and unknown-region
boundaries while proving the actual service/SDK/native HTTP integration.
