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
options from the caller cannot broaden the published route. An injected model
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
Shared consumer scope propagation and the direct Decision Gateway require
further integration. This is not completion of #231.

Validation: cloud Linux, PG17 on loopback port 55599, isolated database
`mikka_admission_closeout_e2e`, all 155 migrations. Contract tests: 3 passed.
Real PostgreSQL store tests: 7 passed, zero skips, including refusal to publish
over a live native run and current call audits. Source model-wrapper tests: 6;
actual Gateway SDK with a real loopback HTTP 307: 1; HTTP handler: 1; claim: 15;
subscription snapshots: 8. All passed. Framework/provider fixtures are explicit
and do not represent live external model requests. Logs use the
`/tmp/mikka-admission-` prefix, including `store-wired.log`, `model-unit.log`,
`redirect.log`, `http-unit.log`, `claim.log` and `subscription.log`.

Outstanding acceptance includes live model requests, child/fallback transport,
native CLI model enforcement, actual provider-region evidence, and the main
site user path. A mock provider, database test or model name is not that proof.

Risk estimate: policy bypass across principal/workspace or provider routes is
occurrence 6 × impact 8 = 48. This is an engineering estimate. The concrete
gap is that current model selection/billing lacks an organization model route
allowlist; the store and its tests address only persisted rule authorization.
