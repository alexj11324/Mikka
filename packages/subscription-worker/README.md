# CPA subscription worker

This implements an owner-scoped CPA storage and lifecycle slice, exercised with
synthetic grants, actual CPA SDK managers and real isolated Postgres. It does
not register built-in live model executors/authenticators or enable the connect
UI. No identity cloaking/fingerprint transport runs in these tests.

Run on the cloud Agent's Linux machine:

```sh
pnpm test:byos-worker
```

The script fetches the exact official commit in `CPA_COMMIT`, starts a disposable
loopback Postgres, applies all migrations, builds the private stdio executable,
runs race tests and vet, repeats migrations, and removes the database. Docker
images are pinned by digest. Go uses the locked module sums. No platform keys,
real credentials, `.env` files, external provider calls or E2B resources are used.

`bootstrap.mjs` adds one original type-alias bridge to the ignored upstream
checkout; no tracked upstream source is modified. This lets tests instantiate
the real internal Codex/Claude storage structs and call the real partition
refresh-patch logic without copying that implementation into Mikka.

## Implemented boundary

- `Store` satisfies CPA's actual `auth.Store`. Each instance has an immutable
  owner/workspace/connection scope; there is no global per-request store switch.
- Acquisition uses `sdk/auth.Manager.Login`; its authenticator is injected by
  trusted host code. The test authenticator exchanges a synthetic code with a
  TLS fixture issuer and returns actual CPA `Auth.Storage` values. The store
  never calls `SaveTokenToFile` or runs imported hooks/helpers.
- Refresh uses `auth.Manager.Load` and `ForceRefreshAuth` with a scoped Store
  and a host-supplied executor. Only one Postgres refresh claim succeeds. The
  executable registers neither live authenticators nor executors; production
  acquisition/inference stays unavailable pending reviewed provider adapters.
- Canonicalization preserves token/identity/expiry fields, separates Codex's
  outer and SIWC grants, and rejects or drops endpoint, header, proxy, filename,
  hook and fingerprint configuration. Inference hydration omits refresh/ID
  tokens. The refresh authority alone receives the rotating grant.
- Infisical v4 REST creates one unique secret per operation and reads exactly
  version 1 with imports/reference expansion disabled. It never PATCHes or
  assumes CAS. Workload tokens remain private process configuration.
- Postgres contains ownership/state/epoch/version/reference/digest only. Stage
  is durable before secret creation; publication compares operation, epoch and
  credential version. Normal rotation preserves account epoch and bot bindings.
- Lost-write or failed database-publication recovery reads the staged secret
  and verifies scope/digest, then publishes without another OAuth/refresh call.
  Missing or invalid staged values stay unavailable. An expired refresh lease
  never authorizes replay of a potentially rotated grant.
- Disconnect/reconnect fence future reads and writes immediately. Provider-side
  logout, revocation, historical secret deletion and orphan-version GC are
  separate integration steps. No claim of instantaneous cancellation of an
  already transmitted inference request is made.

## Native CLI status

The private `CodexNativeAuth` helper constructs the documented experimental
`chatgptAuthTokens` parameter shape using access-only material. It is not exposed
by stdio status/execute responses. Offline tests verify shape and redaction;
the daemon's optional owner-bound broker now implements experimental login and
host-refresh RPCs. Fake app-server tests verify account binding, access-only
handoff, no native-auth link, sanitized failures and no paid-mode fallback.
Actual CPA-token audience and a pinned official CLI remain unverified; the
worker-to-daemon private broker is not wired into the production launcher.
SIWC routes are refused by the native helper rather than silently converted.
For Claude, `ClaudeNativeAuth` supplies an access-only expiry-bounded lease for
the documented `CLAUDE_CODE_OAUTH_TOKEN` input. The daemon's optional broker mode
uses a separate runtime home, requires first-party/no-API-key account mode before
sending a prompt, sanitizes auth failures, and ends at access expiry. This SDK
has no documented host refresh callback; it cannot renew the child environment
mid-session. The next start reuses the CPA worker's one refresh authority.
Seven fake CLI tests cover this boundary. Native credential-file conversion is
not implemented; no CPA JSON is written to `.credentials.json` or project files.
Real CPA grant scope/native acceptance, private launcher wiring and runtime
isolation are release gates for both providers. A native process necessarily
holds access material; config directories do not prevent a hostile same-user
shell from reading it. Existing local native-login modes remain independent.

The binary accepts one trusted configuration frame over stdin, then private
owner-bound requests. It opens no HTTP port and reads no credentials from the
environment or filesystem. The shipped registry intentionally permits only
metadata, recovery and disconnect until live adapters are reviewed and wired.

## Release gates

The live Mikka model/connection API is not registered yet. It needs authenticated
consumer binding, quota/capability policy, cancellation and the chosen runtime
boundary. Infisical permissions, region/project/path and workload delivery must
be configured only with separate authorization. Native token compatibility,
provider flows and E2B lifecycle/isolation require separately scoped acceptance.

References: [CPA Store](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/cliproxy/auth/store.go),
[Infisical create](https://infisical.com/docs/api-reference/endpoints/secrets/create),
[Infisical versioned read](https://infisical.com/docs/api-reference/endpoints/secrets/read),
[Infisical update contract](https://infisical.com/docs/api-reference/endpoints/secrets/update).
