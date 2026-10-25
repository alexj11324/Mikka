# BYOS cross-environment custody transfer

This follow-up is stacked on frozen PR255 `ba4bf38`. It does not change that PR or
activate production. Production account recovery/Google linking is separate and
already verified; this document is not a claim of live BYOS execution.

## Implemented path

The existing POST `/mikka/api/subscriptions/enrollments/bind` still requires both
source-binding proof/operator authorization and a genuine Mikka session, then
checks workspace membership. The browser supplies enrollment ID, workspace and
scoped proof only. It cannot supply destination, approval, owner, token or bundle.

`MIKKA_BYOS_TRANSFER_APPROVAL` is a strict server-controlled metadata manifest.
Only the manifest's enrollment is transferred; other enrollment binds retain the
ordinary path. `EnrollmentClient` obtains independent short source/destination
workload tokens and sends them over private stdin to the custody worker. Neither
identity nor raw bearer reaches model/native CLI environment, browser or response.

The worker validates actual vault clients against the manifest, journals its
immutable digest in Postgres before reads, pins the source v1 digest and provider
subject on every load, and uses the existing global source ownership claim and
canonical publication state machine. Destination grant/access writes are
create-only, with read-back before publication. Exact retries recover staged
writes; they cannot overwrite refresh version2 or resurrect a disconnected epoch.
An expired manifest cannot start a new journal, but an identical durable operation
can recover after expiration. This is intentionally not a generic token importer.

The original source bundle/attempt is **never automatically deleted**. A durable
journal marker excludes these names from later local cleanup, even when the
transfer configuration is removed. Status reports `external_source_retained`.
Normal canonical/access disconnect fencing and retryable local cleanup continue.
This does not revoke provider authorization or delete the retained staging copy;
those actions need a separately implemented/approved source lifecycle operation.

Source or destination permission denials invalidate only that identity's cache.
OAuth/refresh remains the existing CPA lifecycle. This transfer supports the
already-existing **Claude** unbound enrollment format. Codex grant migration is
refused, not claimed as implemented. Hosted required cross-run continuation also
remains fail-closed; neither limitation is changed here.

## Database allowlist

`byos-transfer-migration-manifest.json` contains the exact original seven hashes
plus **one new migration**, `20261025160000_byos_environment_transfers.sql`.
The first seven payloads are unchanged from PR255. The eighth adds only metadata
journal `byos_environment_transfers`, with no tokens. On the previously verified
49-migration production baseline the full allowlist becomes57; recheck the actual
ledger before applying. Do not run a generic all-migrations command against prod.
The executable local fixture applies all57 and repeats without drift.

The separate legacy projection fix uses allowed `publication_failed`; it does
not change any of the seven CHECK constraints. Pre-stage failure is visible as
`reconnect_required`; a failed status write returns `metadata_unavailable` rather
than silently stranding a usable-looking connection.

## Single approval packet — not executed

Approve these specific external actions together only after the follow-up's CI
and review pass; this file does not grant permission:

1. Apply the eight named/hash-pinned SQL files to Neon project
   `autumn-fire-21908520`, branch `br-autumn-rain-b5leflom`, database `orvilo_mvp`,
   using a checked allowlist and migration ledger. Preserve all existing data.
2. Infisical project `89850d6a-f020-4936-863e-df77380dfe40`, explicit origin
   `https://app.infisical.com` only. Create/use separate BYOS identities, never
   broaden the credential-cleanup identity or deliver admin to runtime:
   - Destination custody: prod `/byos/grants` and `/byos/access` read/create/delete
     for immutable publication and user-requested retryable disconnect cleanup;
     prod `/byos/enrollment-attempts`, `/byos/enrollment-claims`,
     `/byos/pending-grants` read/create/delete for the ordinary enrollment path.
     No edit/overwrite or unrelated paths.
   - Inference reader: prod `/byos/access` read only; no full-grant or refresh access.
   - Temporary migration source: staging `/byos/pending-grants` read for
     `mikka-byos-46786d33-159b-4236-880b-951742e98d3e`; read relevant enrollment
     attempt/claim/creation receipts, and read/create the deterministic binding
     claim in `/byos/enrollment-claims`. No source edit/delete. Apply secret-name
     restrictions if supported by the actual role API; do not silently broaden.
3. Server-only Universal Auth bootstrap credentials in Vercel **mikka** project
   `prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`, production backend, supplied by controlled
   configuration. Variables:
   `MIKKA_BYOS_VAULT_AUTH=universal`, explicit origin/project/environment/path
   settings, `MIKKA_BYOS_CUSTODY_CLIENT_ID/CLIENT_SECRET`,
   `MIKKA_BYOS_ACCESS_CLIENT_ID/CLIENT_SECRET`, and temporary
   `MIKKA_BYOS_TRANSFER_SOURCE_CLIENT_ID/CLIENT_SECRET`.
   Runtime access tokens requested with600s TTL; cached only in trusted process
   memory and renewed by fresh Universal Auth login. Source requires >105s and
   custody >335s remaining lifetime. Bootstrap credentials are persistent access
   capabilities; retain destination identities for normal reuse, disable the
   temporary source identity after verified transfer. Confirm supported bootstrap
   expiration/revocation options before issuance, without broadening permissions.
4. One server-to-server transfer of the existing Claude612 grant (no new OAuth),
   source staging `/byos/pending-grants`, enrollment
   `46786d33-159b-4236-880b-951742e98d3e`, to prod `/byos/grants` and access-only
   `/byos/access`. Destination owner `XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ`
   (`alexjiang20232024@gmail.com`), workspace
   `ed898131-d8ea-4734-8e83-9ee2cdfe9206`. Provider account remains
   `alexjiang612@gmail.com`; these emails deliberately need not match.
   Trusted preflight must verify actual provider subject, immutable source version1
   and digest, original source principal, and destination DB identity before
   constructing a15-minute manifest. Do not invent those values from email.
   Retain the original source and all prior attempts. No real deletion approved.
5. Release the reviewed combined application via the parent's single release
   candidate, not a competing deploy. Complete binding through the user's genuine
   production session and scoped proof, never direct SQL or invented auth cookies.
   Then schedule the previously bounded real project-run acceptance: cloud Linux
   Mikka daemon/broker, not standalone CLI; maximum two short inferences per
   provider,256 output tokens each, no paid API fallback or E2B provisioning.

Current code/fixture work performs **none** of these external actions. No new
provider grant, real secret read/copy, IAM change, production SQL or deployment.

## Failure and recovery rules

- Wrong destination/owner/workspace/provider/subject/digest/revision: fail closed.
- Lost create response: read the exact immutable artifact; resume original names.
- Database receipt failure after publication: return failure; identical retry
  verifies current publication and writes receipt, without another OAuth exchange.
- Refresh after migration: retries verify the current version; never restore the
  old escrow over a rotated grant.
- Reconnect/disconnect: existing epoch fencing rejects the old migration.
- Changed approval for a journaled enrollment: reject. Correction requires an
  explicitly reviewed recovery action; there is no public journal-edit endpoint.
- Source retention is visible, not mislabeled deletion or provider revocation.

## Verification boundary

Real disposable Postgres plus local HTTPS source/destination fixtures exercise
actual Go store serialization and the production custody executable through the
app handler. Fixture sessions are explicitly synthetic. Local CONNECT proxy only
routes `app.infisical.com:443` to a test TLS server; TLS verification stays enabled
with a test-only CA. It never contacts Infisical or a provider.

These checks do not prove actual612 transfer, production IAM, real model inference,
E2B isolation or resumed hosted CLI sessions. Keep those unchecked until performed.
