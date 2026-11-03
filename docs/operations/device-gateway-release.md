# Device gateway release and acceptance

The `Device gateway` workflow updates the existing `mikka-device-gateway`
Worker only after the matching application is serving the existing production
alias. The order matters: the old application treats an idle daemon's stopped
HTTP heartbeat as offline, even after the WebSocket handshake is repaired.

## Existing resources and delivery

The workflow uses the existing Infisical GitHub OIDC identity
`2cf9fa19-b9db-4c08-8ca0-b31859f2cbac`, audience `mikka-infisical`, project
`89850d6a-f020-4936-863e-df77380dfe40`, and individual values from `prod:/platform`:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `VERCEL_TEAM_TOKEN`.
The Vercel token is used for GET requests only. The Worker secret is not
downloaded, replaced, or copied to a file. No identity or cloud resource is
created. Missing access or missing existing resources fails the job.

PRs run the release ordering and real workerd/Node WebSocket handshake tests
without secrets or OIDC permission.
Only a push or manual dispatch on `alexj11324/Mikka`'s `main` can deploy.
Manual dispatch is useful for retrying a read/preflight failure after fixing
existing delivery. The script does not automatically retry a failed or uncertain
Wrangler upload; inspect the provider's deployment record before rerunning it.

The runner installs the repository's locked dependencies, then uses the existing
`scripts/release/ci-gate.mjs` with the job's read-only GitHub token to require
successful main CI for that exact source SHA, before obtaining any platform
credential. Wrangler is the existing dependency from `pnpm-lock.yaml`.
The production job has a single concurrency group and does not cancel a running
upload in favor of a later release.

## Release checks

`scripts/device-gateway/deploy.mjs`:

1. Checks the immutable checkout and the presence fix in that source commit.
2. Reads the existing Worker settings and requires exactly the existing
   `DEVICE_SESSION` binding to `DeviceSession`, its existing namespace ID, and
   a `GATEWAY_PUSH_SECRET` secret binding. It requires the existing `v1`
   migration to be applied. Additional resources, migrations, environments,
   or a different Worker name are refused by the local configuration check.
3. Confirms Vercel project `prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`, team
   `team_C7lwxVVvnUicFli6112mvxpv`, and its GitHub repository link.
4. Checks at most 60 times, waiting 30 seconds between checks, for
   `app.aspectlylabs.com` to point to a `READY` production deployment whose
   commit contains the release source. It does not use a preview or an older
   deployment discovered by searching history. Provider reads have 20-second
   timeouts, and the complete job has a 60-minute limit including the existing
   release gate's maximum 20-minute wait.
5. Fetches the current main ref and compares gateway source/configuration,
   the shared ticket, presence and notification implementation, and the release script/workflow. If a
   newer main commit changes any of those inputs, the older release skips
   its write. An unrelated application commit may advance main and production.
6. Rechecks main, production alias, existing namespace and applied migration
   before invoking `wrangler deploy --keep-vars` once. It then requires the
   returned version to serve 100% of the Worker and the namespace to be unchanged.

The release report contains source SHA, serving application deployment/SHA,
Worker version and namespace ID. It contains no credential or ticket. A passing
release proves deployment identity and ordering; it is not the one-hour runtime
acceptance below. There is a brief normal race between the last provider read
and the upload; the shared workflow concurrency group serializes this repository's
deployments. An independent manual production writer must not run concurrently.

API contracts:
[Cloudflare Worker settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/),
[Vercel alias](https://vercel.com/docs/rest-api/aliases/get-an-alias).
Wrangler's installed migration code reads
`/accounts/:account/workers/services/:worker` to decide whether `v1` is already
applied; this script checks that same field before allowing the upload.

## Runtime acceptance

The request accounting, one-hour observation requirements, duplicate-build
evidence and current limitations are maintained in the
[issue #1156 acceptance record](../acceptance/2026-11-03-device-gateway-reliability.md).
A successful release job does not establish that runtime acceptance.
