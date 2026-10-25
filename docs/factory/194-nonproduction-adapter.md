# Nonproduction adapter wiring and controlled local acceptance

`lib/factory/local-publication.ts` implements an actual local artifact target. It validates the exact repository and candidate provenance, plus a separately approved `local-*` destination environment, accepts only the server's UUID reservation as a filename, creates an immutable mode-0600 candidate record, fsyncs it and verifies its contents by reading it back. Its receipt is `local-artifact:<reservation>:sha256:<content hash>`. This publishes a candidate record into an isolated local target; it does not deploy an application or manufacture a provider success response.

## Existing server wiring

`lib/factory/server.ts` supplies `configuredLocalPublicationAdapters(process.env)` to the existing approval service. Enabling the local target requires all of these explicit, nonsecret runtime settings:

```sh
NODE_ENV=development
BETTER_AUTH_URL=http://127.0.0.1:3000
FACTORY_PUBLICATION_MODE=local-artifact
FACTORY_LOCAL_PUBLICATION_ROOT=/tmp/mikka-controlled-local-target
FACTORY_LOCAL_PUBLICATION_TARGET=local-controlled-acceptance
FACTORY_LOCAL_PUBLICATION_REPOSITORY=alexj11324/Mikka
FACTORY_LOCAL_PUBLICATION_ENVIRONMENT=local-acceptance
FACTORY_LOCAL_PUBLICATION_CANDIDATE_ENVIRONMENT='device:replace-with-the-exact-existing-device-uuid'
```

Do not persist these values in a credential file. The configuration rejects production mode, any Vercel environment, non-loopback origins, non-HTTP origins, missing fields and non-local destination environments. No network or provider credential is read. Outside this explicit mode, no cloud/deployment adapter is installed and the endpoint fails closed. The target is supplied by trusted runtime configuration, never an agent/tool argument; the human still approves its exact identifier and candidate scope.

Run `lib/factory/local-publication.test.ts` with the existing Factory tests. `approval.test.ts` now uses this concrete adapter for its PG/service acceptance: ten competing publication calls materialize one real record, read it back and assert the exact candidate, target and receipt. Additional adapter tests reject production/repository mismatches, path traversal, changed scope under a reused reservation and corrupted target contents. Tests remove their own temporary target afterward. Upstream run identities/results and human accounts remain explicitly synthetic; local artifact publication does not finish the real Preview/Harness acceptance.

## Authorized cloud Preview adapter design — not executed

The existing `PublicationAdapter` seam is the only effect hook. A future approved Preview adapter must be registered here for an exact configured action/target; no new workflow engine, IAM grant or credentials are necessary in #194. The parent must first provide/approve:

1. The existing nonproduction provider/project/team identifier, target environment, repository and allowed fixed candidate scope. A shared production alias or moving branch alias is not an acceptance target.
2. The existing workload identity or secret-managed runtime client entry point. It must not use an old CLI account, copy secret values to this branch or add persistent access.
3. The explicit approval for the previously denied Preview operation. An unapproved provider client must not be constructed or invoked just to test it.

Once those inputs exist, the trusted adapter will:

1. Reuse the server-held task/approval fence; inspect the configured provider target and reject a production environment or a different repository before creation.
2. Request the exact immutable candidate SHA (never `main`/`Latest`/a moving branch), pass the reservation UUID as the provider's existing idempotency key/metadata, and use only the already granted Preview capability.
3. Read the created operation back from the provider. Before returning its receipt, validate actual operation ID, repository, resolved SHA, target/project/environment and terminal ready state. Return a unique immutable Preview URL/reference, never an optimistic request ID or branch alias as proof of deployment.
4. On pending, timeout, provider error, mismatched SHA/target or unknown outcome, throw and preserve the durable reservation as uncertain. Do not invoke creation again. An operator can perform read-only reconciliation using the reservation/operation ID; any future resume API requires a coordinated design and another full fence check.
5. Preserve sanitized request/reservation/provider-operation IDs, command/API action, timestamps, outcome/exit details and receipt references in the existing evidence path. No tokens or cookies enter receipts/logs/screenshots.

No provider-specific start request or deployment was made while preparing this design. Preview authorization remains pending in the parent; production publication remains explicitly unavailable. An empty cloud configuration is an outstanding integration dependency, not completion of #194.
