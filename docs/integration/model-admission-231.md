# Model admission (#231)

The workspace policy row owns `model_admission`; there is no second policy
registry or execution epoch. Policy contents are exact model/serving-provider
allowlists, fixed Gateway transport, optional principal IDs and explicit data
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

Native CLI and subscription transports currently cannot attest this routing
contract. A configured policy refuses those paths before claim/credentials or
model construction; unconfigured ordinary execution retains its behavior. A
policy cannot be published over unfinished native work in its Bot or task
workspace. Publishing a rule cannot retroactively recall an already-issued
provider credential or an in-flight request. This is an explicit unsupported
managed transport, not completed positive native-CLI acceptance.

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

Outstanding acceptance includes live model requests, child/fallback transport,
native CLI model enforcement, actual provider-region evidence, and the main
site user path. A mock provider, database test or model name is not that proof.

Risk estimate: policy bypass across principal/workspace or provider routes is
occurrence 6 × impact 8 = 48. This is an engineering estimate. The concrete
gap is that current model selection/billing lacks an organization model route
allowlist; the store and its tests address only persisted rule authorization.
