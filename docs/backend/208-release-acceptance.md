# #208 coordinated release and real-user acceptance

The user now requires coordinated production deployment, real production usability
and acceptance video on the PR. This supersedes candidate-only completion, but does
not authorize independent merges/deployments, new credentials/IAM/spend, deletion,
unapproved external effects, or publication of private traces. Parent coordinates
one integrated SHA and release order. Keep #208 open until all applicable gates pass.

## Current gate checklist

- [x] Isolated durable ledger, tenant binding and concurrency tests.
- [x] SIGKILL before send and after synthetic HTTP success; distinct process recovery.
- [x] Real Better Auth + PG + HTTP session/approval expiry/revocation fixtures.
- [x] Independent code review; discovered deadlock and unique-index race fixed.
- [ ] Latest candidate terminal CI (record its exact SHA, not previous green runs).
- [ ] #177 proposal identity/account binding and real execution bridge integrated.
- [ ] Cross-retry intent propagation and execution-boundary fencing integrated.
- [ ] Parent-frozen unique preproduction URL, migrations, integrated exact SHA.
- [ ] Real OAuth session and authorized controlled provider target available.
- [ ] Same-version preproduction end-to-end success and failure matrix passed.
- [ ] Parent-coordinated production deployment of that verified version.
- [ ] Actual production user flow and independent provider readback passed.
- [ ] Sanitized acceptance video reviewed and attached to PR #220.

The API fixture is not a deployed Mikka route, and its synthetic Better Auth account
is not human OAuth acceptance. Production domain bindings remain absent. No genuine
preproduction/production video exists yet; do not substitute a synthetic test video.

## Executable read-only verification driver

`scripts/verify-operation-acceptance.mjs --help` is safe without network activity.
After integration and parent authorization, run it with a PRIVATE manifest and an
existing authorized browser storage-state file, both outside the repository:

```sh
node scripts/verify-operation-acceptance.mjs --execute-readonly /private/manifest.json /private/browser-storage-state.json
```

The manifest supplies deploymentUrl (unique HTTPS origin), expectedSha (40-char exact
integrated commit), operationId, ownerId, workspaceId, providerObjectId, versionPath,
operationPath and providerReadbackPath. These paths are supplied by the integration
owner; no corresponding routes are added or presumed by this candidate. Version
readback returns `{sha}`, operation readback returns the ledger record, and independent
provider readback returns `{source:'provider',providerObjectId,idempotencyKey}`.
Audit the last route to ensure it actually queries the remote provider, rather than
copying the ledger. The driver refuses redirects and cross-origin/credential/query
URLs, checks version before and after, and prints only SHA/time/pass-fail. It makes
GET requests only; it does not create, approve, retry, publish or delete anything.
Missing endpoints/session/target are a prerequisite failure, never a passing skip.
The driver is prepared but has not been run against a real deployment.

## Preproduction action script (parent-owned integration version)

1. Record exact integrated app/worker SHA, migration, unique URL, approved provider
   action/account/target, and private evidence destination. Do not use moving Latest.
2. Reuse authorized Google/GitHub OAuth in a top-level browser as docs/acceptance.md
   requires. Stop only for the specific unavailable provider/MFA/permission step.
3. Through actual Mikka, submit one controlled action. Record its durable proposal /
   operation identity privately. Confirm displayed target/account/payload match.
4. Before approval, verify zero remote effects. Exercise decline and expiry with
   separate retained controlled proposals; verify no provider writes. Exercise a
   foreign owner/workspace and revoked session; verify server rejection.
5. For the explicitly authorized positive action, approve once. Verify receipt and
   actual remote object, then run the read-only driver against the frozen version.
6. In preproduction only, inject a worker stop after provider success and before
   receipt commit. Start the retry with the same logical operation ID. Verify lookup
   or uncertain, no blind send and no false success. Also test claim-before-send,
   loss of reply, 10-way contention, old-attempt rejection and authorization revocation.
7. Preserve raw evidence privately, including failures. Do not delete test records or
   remote objects without separate cleanup approval. Fix/retest on a new frozen SHA.

## Production verification and video

Only after every preproduction gate passes does the parent coordinate deployment.
On production, use the actual user flow and an explicitly authorized controlled
provider target. Confirm deployed SHA and migrations; repeat normal propose/approve/
receipt/remote readback and safe rejection checks. Do not inject process kills,
partitions or database faults in production without distinct authorization.

Start recording AFTER OAuth/MFA, with an already authenticated browser. Use an
isolated browser profile, hide unrelated tabs/bookmarks/notifications and restrict
framing to the tested Mikka flow and controlled remote object. Show version, proposal,
actual approval result and independent remote readback; retain meaningful failures
and do not edit them into apparent success. Store original video privately outside
the repo; never commit it or upload raw browser state, HAR, model logs or DB dumps.

Before PR attachment, inspect every frame and audio track for tokens, addresses,
account names, private prompts and unrelated data. Create a cropped/blurred derivative
where necessary, review it independently, and preserve the private original. Attach
only that reviewed derivative to the corresponding PR using an authorized attachment
path; if no safe upload capability exists, report the exact upload blocker. A textual
CI summary, mock video or synthetic loopback recording does not satisfy this gate.
