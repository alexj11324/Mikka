# Credential cleaner Universal Auth preparation

This default-off follow-up to PR252 implements server-side short-lived access-token acquisition. No production identity, client secret, permissions, record, schedule, or deployment is changed. The Worker continues using only its existing CRON_SECRET.

## Authentication contract

The repository uses its existing small REST vault adapter, not the Infisical SDK. Follow the official Universal Auth login contract: POST /api/v1/auth/universal-auth/login with clientId/clientSecret, parse accessToken/expiresIn/tokenType. Before expiry, obtain a fresh token through the same login endpoint; this deliberately avoids renewal maximum-lifetime exhaustion. This is automatic access-token refresh, not an implementation of the renew endpoint. Tokens are memory-only per server instance, with single-flight requests within that instance and monotonic expiry accounting from before the HTTP request. Cold instances authenticate independently. There is no background timer required in serverless compute.

Accepted token lifetime is30–3600seconds (proposed provider setting600seconds); refresh starts10% early, capped at60seconds. Failed refresh discards the old token and blocks requests for30seconds. Authentication401/403 latches failure until configured client credentials change or the instance restarts. Vault401/403 invalidates the cached token and does not retry the delete. A late successful login cannot overwrite a newer configuration or a denial. Responses and exception causes are discarded; redirects are refused and auth transport has a5second timeout. Production origin must be HTTPS. Tests map this fixed origin into an isolated loopback HTTP fixture; they do not contact Infisical.

Runtime selection is explicit MIKKA_CREDENTIAL_CLEANUP_AUTH=universal. Only the cleanup broker receives this identity; the admission broker's existing auth remains separate and disabled. Missing client credentials or disabled mode fails closed for an instantiated Universal Auth provider; there is no fallback to the old static token. The currently supported static mode remains unchanged for existing users but is not the proposed production cleaner binding. Runtime is server-only; no client bundle or Worker receives these values.

For global revocation, revoke the Universal Auth client secret or the identity/provider permission, not merely a single instance's access token. Other instances may already hold tokens. Provider enforcement is authoritative: official documentation notes that revoking an individual access token can be delayed during provider-cache failure. This code cannot promise cessation of an already dispatched request or stronger revocation than Infisical enforces. The synthetic tests prove reaction to rejection, not live provider revocation latency.

Sources: https://infisical.com/docs/api-reference/endpoints/universal-auth/login ; https://infisical.com/docs/documentation/platform/identities/universal-auth ; https://infisical.com/docs/documentation/platform/identities/machine-identities

## Exact persistent binding approval still required

No creation is authorized by this code preparation. Proposed scope for the user:

- Existing Mikka Infisical project89850d6a-f020-4936-863e-df77380dfe40, environment prod. Create exact folder /credential-custody/production and identity mikka-credential-cleanup-production. Custom role: delete secrets only in that exact folder, no descendant wildcard, read/create/update/list-secrets/admin/folder-delete permission. Verify provider policy enforcement; any required broader permission requires a new decision.
- Enable Universal Auth on this identity. Proposed access-token TTL600seconds, maxTTL600seconds, periodic/nonexpiring access-token mode disabled. One bootstrap client secret stored only through existing prod/vercel secret delivery. Proposed bootstrap lifetime90days with managed rotation before expiry and emergency revocation; access tokens refresh automatically without daily human involvement. Client-secret issuance/rotation is a separate privileged control-plane action, not performed by this delete-only runtime. Do not claim client-secret auto-rotation is implemented here; the chosen operational rotation/expiration policy must be recorded before sustained enablement.
- Bind MIKKA_CREDENTIAL_CLEANUP_AUTH=universal, MIKKA_CREDENTIAL_CLEANUP_CLIENT_ID, MIKKA_CREDENTIAL_CLEANUP_CLIENT_SECRET, and MIKKA_CREDENTIAL_VAULT_ORIGIN=https://app.infisical.com, PROJECT_ID=89850d6a-f020-4936-863e-df77380dfe40, ENVIRONMENT=prod, PATH=/credential-custody/production. Target only existing Vercel mikka/prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH production. No vault token/client secret in Worker, preview, local env files, logs or artifacts. Preserve existing broker/admission/browser-disabled flags.

## Synthetic acceptance approval is separate and bounded

Use three fixed UUID references exclusively for this acceptance, in prod /credential-custody/production, with isolated naming prefix MIKKA_CREDENTIAL_25200000:

1. 25200000-0000-4000-8000-000000000001 -> MIKKA_CREDENTIAL_25200000000040008000000000000001 (expiry)
2. 25200000-0000-4000-8000-000000000002 -> MIKKA_CREDENTIAL_25200000000040008000000000000002 (revocation)
3. 25200000-0000-4000-8000-000000000003 -> MIKKA_CREDENTIAL_25200000000040008000000000000003 (transient failure/retry)

First read exact-name existence; if any exists, stop rather than overwrite/reuse it. Setup and inspection require explicit authorization for the existing operator identity to create/read ONLY these nonfunctional synthetic values and matching credential_requests, using separately verified existing synthetic owner/run/session handles. Runtime cleaner remains delete-only and may delete ONLY the values in the dedicated folder. No new user/grant/real credential may be inferred from this approval. Preserve database tombstones/audit evidence; no business-row deletion. Values are generated in memory and never printed.

Required evidence: actual deployed Next cleanup route with identity binding -> exact synthetic vault deletion -> tombstone cleanup_pending=false. For synthetic-only controlled failure, retain pending then demonstrate subsequent scheduled retry. Also prove live provider rejection after revoking a dedicated test client secret, no successful delete afterward, and controlled recovery through a newly approved replacement binding. Revoking the production cleaner identity while it holds real workload is not included in this synthetic approval. 200checked alone is not acceptance. No actual acceptance records/values have been created by this change.

## Evidence scope

Local fake clock tests cover concurrency, early refresh, stale login, malformed/long-lived tokens, refresh outages and rejection. A real loopback HTTP fixture covers auth/delete/error/redirect transport with synthetic credentials. These are authentication mechanism tests, not production Infisical acceptance. Full remote CI and independent review are required. Scheduler enablement/cutover still needs its own reviewed config change and actual Cloudflare -> Next -> database/vault evidence; Vercel minute cron and existing Worker daily schedule remain unchanged.
