# Factory monitor V2 production binding

Consumes #194 receipt V2 explicitly in normal monitor dispatch, probe recording,
observation and gate validation. The old V1 reader remains unchanged and rejects
production. No stages, migrations, publication ledger or orchestration workers
are added. #193's two frozen question-ancestry fixes are included unchanged.

The finished GET-only monitor registers by default when
`FACTORY_VERCEL_PUBLICATION=1` and the existing secret-managed `VERCEL_TOKEN`
configure publication. There is no second required rollout opt-in. The existing
explicit `FACTORY_VERCEL_MONITOR=0` operator stop remains effective;
`FACTORY_VERCEL_PRODUCTION=1` additionally selects production. Publication's
resource/cost choice remains explicit, and monitoring never enables publication.
An explicit monitor opt-in without publication or a configured publication
without credential delivery fails closed. Registration creates no token, IAM
grant, deployment or resource.

The registered Mikka scope is the same team/project/repository as #194. The
production alias is `https://app.aspectlylabs.com`. Probe reads use only GET:
project identity, exact deployment operation, production alias before and after
application health (or a second exact operation read for Preview). They require
provider `gitSource.sha`, repository identity, team/project, environment, READY,
immutable reference, publication UUID and binding hash to match the receipt.
Caller-supplied metadata SHA alone never proves deployed code. A moved alias
blocks the old candidate; it cannot cause automatic restoration of an obsolete
production deployment.

`GET /mikka/api/health` returns no-cache `{status:"ok",service:"mikka"}`. This is
process HTTP liveness only: no session, secrets, claimed SHA or database query is
returned. Avoiding a database query also avoids competing for pool connections
held by concurrent monitor transactions. Independent Harness verification and
real-user acceptance remain responsible for business/database readiness.

Provider credentials go only to the fixed Vercel API origin; application health
requests carry no credentials. Redirects are rejected; one bounded deadline and
bounded JSON response sizes cover the entire observation. Protected targets
returning 401/403 remain blocked; the code does not create bypass links or tokens.

V2 audit preserves the existing run/session/attempt/candidate fence and seq0 raw
artifact/hash, adding the exact provider receipt identity and observed liveness/
alias facts. Health failure still performs a final identity read. Confirmed 5xx
or invalid health responses with stable target identity enter the existing
fingerprint/original-issue/replay/recovery path. Provider errors, uncertainty,
timeouts and alias/identity mismatches block without inventing a failure target.
Uncertain publication never reaches monitor: its existing ledger must first be
reconciled by #194, and this probe has no POST or publication-retry operation.

Validation includes actual loopback HTTP protocol substitutes and real PG17
composition through #193 gates, #194 publisher/reservation/receipt reader, normal
monitor dispatch/claim, health failure, ten replays, alias movement and recovery.
These use synthetic provider/OAuth/Harness identities and do not constitute real
Vercel deployment or production-user acceptance. Parent coordinates one immutable
release; no worker independently overwrites the current main-site recovery.

The default-registration regression is covered with publication configured but
no monitor rollout flag: the old registry returned no adapter, so a subsequent
monitor could not find its trusted target probe. The same test retains explicit
stop, missing publication, missing credential and production-selection checks.
The focused monitor/proof/fingerprint suite passes 40/40 with actual loopback
HTTP receivers and zero skips; this does not establish live Vercel or model
recovery acceptance.
