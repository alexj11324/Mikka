# Task Secret delivery

Implementation owner: [#1712](https://github.com/alexj11324/Mikka/issues/1712).
Architecture authority: [credential exposure ADR](../design/decisions/2026-11-08-0240-credential-exposure-boundary.md).

## Source audit and migration

The audited baseline is `3c32675c99d32f9c84a9b5e4bc48e59231baa4d8`.
At that version, `loadTaskRuntimeSecrets()` decrypts the matching workspace and
repository rows, then the run owner's personal rows. Repository values override
workspace values; personal values override both. Reserved environment names are
filtered. `taskSecretInjection()` still puts every remaining `kind=secret` value
in `taskEnv`, and the cloud claim returns it to the task VM. The hosted runner
adds it to the native CLI's environment. A shell-capable Agent can read that
environment even when output is masked. This finding is source evidence; it is
not a claim that a production credential has been read or exposed in a report.

| Authority | Current storage / owner | Intended delivery |
| --- | --- | --- |
| Task GitHub credential | Existing GitHub connection / selected run principal | Native Git and gh credential, as before |
| Selected model authentication | Selected subscription or model-key store | Native official Claude Code / Codex credential, as before |
| Personal API Secret | `user_secrets`, authenticated user | Protected capability by default; explicit per-secret direct compatibility |
| Workspace / repository API Secret | `workspace_secrets`, existing scope and permissions | Same protected capability, with resolved scope frozen at admission |
| Non-sensitive configuration | Existing `kind=env` rows | Ordinary environment value |
| Connected apps / MCP | Existing server-side integration custody | Existing authorized operation; no second preflight |
| Saved browser credentials | Separate KMS browser credential broker | Existing browser broker; no new generic plaintext read |
| Platform database / Infisical / deployment credentials | Trusted platform configuration | Never part of task Secret delivery |

The new metadata belongs to each existing Secret row. This change does not
create another vault or introduce Project/Environment entities. It preserves
the current override order and leaves the Project/Environment model to #1687.
Existing protected entries without an HTTP policy need an explicit delivery
choice. They must be reported as unavailable, never automatically downgraded to
direct exposure. Ordinary `kind=env` entries retain their behavior. A person who
chooses direct mode accepts that the Agent and same-permission host processes
can read that value; masking does not change that fact.

Protection applies to claims issued by the new server to a compatible daemon.
This migration does not stop already-running tasks or erase plaintext delivered
by an earlier claim. Those tasks must finish, or be explicitly stopped and
started under a new claim, before relying on the new delivery boundary.
Plaintext already copied to files, logs or snapshots remains known. Revoking
or rotating it at the upstream provider is required if that prior authority
must be withdrawn; masking is not retrospective protection.

## Protocol and trust boundary

Claim resolves owner, workspace, exact repository, run, device and claim
credential using the existing authorization path. A short-lived encrypted
capability carries only the resolved HTTP grants. The encryption key remains on
the trusted application service. Capability encryption has its own domain; it
must not accept a stored-row ciphertext as a grant or vice versa.

The third-party data-plane handler validates the capability and the requested
operation, injects authentication, and makes the authorized HTTPS request. It
does not read the control-plane database or call a remote authorization API.
The native model and GitHub paths do not call this handler. Any local SDK bridge
holds opaque capabilities only: it is a compatibility adapter, not the
confidentiality boundary. A local sidecar holding plaintext would not satisfy
this design.

HTTP policy pins the HTTPS origin (including an explicitly configured port),
permitted method and exact path or bounded path prefix, and authentication
header. Requests cannot change that origin or port. It rejects URL credentials,
fragments, ambiguous paths, attacker-supplied authentication, redirects,
private/reserved addresses and DNS rebinding. The actual TLS connection must use
the address checked by the egress handler. Request and response sizes and time
are bounded. Error and trace output contains closed error codes, not URLs,
headers, capabilities or credential-bearing exception messages.

Paths containing semicolons (matrix/path parameters) are unsupported: some
upstreams remove them before resolving dot segments, which could otherwise
escape an approved prefix. Ordinary query parameters remain supported as part
of the approved API's authority; path/method filtering does not establish that
every business operation expressible through those parameters is safe.

Capabilities expire no later than the current run lease (90 seconds). Renewal
uses the existing authenticated device heartbeat and only a successfully
renewed, matching claim; no new polling or provider/tool preflight is added.
The entire heartbeat has a 4 MiB wire limit, checked before device
authentication or database writes. Each run remains limited to 32 grants and
256 KiB of serialized access data. This permits 15 maximum-size bundles plus
ordinary heartbeat metadata; the existing 500-run schema does not promise
500 maximum-size bundles. An oversized heartbeat returns 413 instead of
processing a partial set of renewals.
Stopping or revoking a run prevents renewal. The running task's bridge closes
when its existing stop signal arrives. **A copied bearer capability can retain
its already granted authority until that short lease expires.** An in-flight
upstream effect cannot be recalled. The implementation and tests must expose
this bound instead of claiming instantaneous distributed revocation.

Changing or deleting a Secret or its delivery policy invalidates the affected
run authorization, so an old encrypted grant cannot renew indefinitely. A new
claim re-resolves current values and policy. A retry or a different device must
not inherit a previous claim's grant. The daemon omits `taskEnv` and
`taskSecrets` from its assignment journal. Existing output, checkpoint and
artifact masking, including recognized capability patterns, remains defense in
depth; it cannot guarantee that task-controlled files, transformed values or
VM snapshots contain no credentials. Protected third-party plaintext is not
delivered to the task. An opaque capability remains a copyable bearer until
expiry, and explicitly approved direct-mode values remain readable and
persistable by the task.

## Compatibility and remaining authority

Compatible HTTP SDKs can target a per-secret loopback base URL using a dummy
SDK key; the trusted egress supplies the actual key. Ordinary fetch/curl calls
can use the same adapter. The adapter does not change `HTTP_PROXY`,
`HTTPS_PROXY`, provider base URLs, native CLI HOME, Git configuration or official
CLI files. SDKs that sign requests locally, use a non-HTTP protocol, pin the
provider URL, or otherwise require plaintext need a narrow existing server-side
tool, an appropriate short-lived upstream credential, or explicit direct mode.
There is no automatic fallback from protected mode.

The Agent can exercise the allowed API authority. Route restrictions cannot
prove that a third-party API has no dangerous operation or deliberately encoded
credential echo. The destination service and trusted server are inside the
credential trust boundary. Direct echoes are rejected as defense in depth; this
does not establish protection against an adversarial provider, a compromised
trusted server, or root access to that server. On a personal device, unrelated
same-user credentials already on that device are outside this delivery feature.

For self-hosting, the Web/data-plane service and its encryption key must remain
outside the Agent's OS user, container, Docker-admin and root authority. Running
both under the same readable process/host authority cannot provide this
confidentiality boundary. Separating only the loopback bridge is insufficient.

Cloud worker token refresh may create a new device credential ID. The capability
continues to bind the original claiming credential as its lineage. Renewal
accepts a successor only after checking its current owner, cloud device and
workspace, the original claim token's non-revoked state, the run/attempt/lease,
current membership, and the effective Secret ID/revision. Expiry of the old
cloud token alone does not break a legitimate refresh. Revoking that original
claim token prevents all successors from renewing its grants. Revoking one
successor prevents that credential from renewing, without claiming to revoke
other independently valid successors. Local runs require the original token.

## Configuring an existing Secret

Keep creating and rotating values in the existing settings store. This change
adds a small human-only configuration API, not a new environment/settings
system. The API reads a fresh signed-in human session, rejects PAT/device/run
credentials, preserves existing workspace roles, and never returns plaintext,
ciphertext, IVs or capabilities. A delivery change invalidates active affected
runs, so configure it before dispatching the replacement task.

From the browser console of the signed-in Mikka application, list value-free
personal metadata (the standard deployment uses `/mikka` as its base path):

```js
const base = '/mikka'; // Use '' if the self-hosted deployment has no base path.
const response = await fetch(`${base}/api/secrets/delivery?scope=personal`);
const { secrets } = await response.json();
console.table(secrets.map(({ id, name, delivery }) => ({ id, name, mode: delivery.mode })));
```

For workspace and repository entries, use
`?scope=workspace&workspaceId=<workspace UUID>`. Repository entries already
carry their existing `scopeType`/`scopeRef`; this API cannot move a Secret or
select a different owner.

Choose a trusted upstream and the minimum operations required by the task.
This example authorizes only `POST /v1/items` at the chosen origin:

```js
await fetch(`${base}/api/secrets/delivery`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: '<existing Secret UUID>',
    // workspaceId: '<workspace UUID>', // Include for workspace/repository rows.
    delivery: {
      mode: 'protected',
      http: {
        origin: 'https://api.example.com',
        header: 'authorization',
        prefix: 'Bearer ',
        rules: [{ method: 'POST', path: '/v1/items', match: 'exact' }],
      },
    },
  }),
}).then(async response => ({ status: response.status, result: await response.json() }));
```

Supported authentication headers are `authorization`, `x-api-key`, `api-key`
and `x-goog-api-key`. Use an empty prefix for an unprefixed API-key header.
Allowed methods are GET/POST/PUT/PATCH/DELETE/HEAD. A prefix rule for `/v1/items`
also permits `/v1/items/123`, but not `/v1/items-evil`. Paths are unencoded and
cannot contain dot segments; ordinary query strings are supported. Redirects,
compressed responses, streaming APIs, responses above 2 MiB, request bodies
above 512 KiB, and operations longer than 20 seconds are not supported by this
first HTTP delivery. These refusals never trigger direct exposure.

During the task, the Agent receives the `MIKKA_SECRET_ENDPOINTS` JSON mapping
and the compatible dummy key. It can use a standard HTTP client:

```js
const endpoints = JSON.parse(process.env.MIKKA_SECRET_ENDPOINTS ?? '{}');
const result = await fetch(`${endpoints.MY_VENDOR_TOKEN}/v1/items`, {
  method: 'POST',
  headers: { authorization: 'Bearer mikka-protected', 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Example' }),
});
```

For an SDK, set its own base URL to the matching loopback endpoint, preserving
any `/v1` prefix the SDK expects, and set its API key to `mikka-protected`.
Do not change the native Claude Code/Codex provider URL, Git configuration or
global proxy variables. The bridge strips only its accepted dummy authentication;
an arbitrary or duplicate authentication header is rejected. Supported ordinary
upstream headers are `accept`, `content-type`, `idempotency-key`, `notion-version`,
`stripe-version` and `x-api-version`. An SDK requiring additional headers must
be adapted or use an explicitly selected compatibility mode.

For a non-HTTP protocol or a client that must sign locally, the human can
explicitly select this per-Secret compatibility mode through the same PATCH:

```json
{
  "id": "<existing Secret UUID>",
  "delivery": { "mode": "direct", "exposeToAgent": true }
}
```

**Direct mode gives the Agent the plaintext environment value.** Its approval
actor/time are authored by the server; clients cannot forge them. Bulk import
cannot opt into direct mode. Rotating an existing direct entry retains its
explicit approval; a newly imported entry defaults to protected. To withdraw
direct access, PATCH `delivery: { mode: 'protected' }` or a complete protected
HTTP policy. Stop/rotation prevents future grants, but cannot recall plaintext
already deliberately delivered or undo an upstream operation already accepted.

Protected entries without a usable HTTP policy are named in
`MIKKA_SECRET_UNAVAILABLE` and the task instructions. They remain absent from
the environment; the task can explain the required configuration without
printing or guessing a credential. Updating a note alone does not revoke a
grant; changing value/scope/delivery does. Restarted daemons discard withheld
credentials and require a fresh task claim instead of resuming from disk.

## Implementation evidence

- [Baseline exposure probe](evidence/task-secret-baseline.json) uses the exact
  baseline task-environment assembler and real Node, `printenv`, Linux procfs,
  ordinary file and nested-process reads. All canary reads succeeded; no real
  credential or raw canary is included in the evidence. This is an isolated
  process reproduction, not a production database/claim measurement.
- `packages/daemon/test/task-secret-child.test.ts` starts the actual supervisor,
  bridge and two real Node HTTP-client subprocesses, renews the opaque grant
  between `fetch` calls, and reads the actual journal/outbox files. Neither
  canary nor capability is in the complete supervisor child environment or
  persisted journal. Native credential options retain their existing path.
  This test remains compatible with the daemon's Node 18 matrix.
- `tests/task-secret-sdk.test.ts` separately runs the installed
  `@ai-sdk/openai-compatible` / `ai` SDK in real Node subprocesses under the
  root Node 24 target. Non-streaming `generateText` calls use the real bridge,
  dummy key and ordinary SDK transport before and after grant renewal. The
  child receives only the bridge environment, public dummy key and test mode. This
  proves installed SDK compatibility with a synthetic third-party endpoint
  returning standard JSON, without changing request-header restrictions.
  Neither process fixture exercises a live vendor or native model connection.
- `lib/secrets/egress-http.bench.ts` measures a real local HTTP data-plane hop
  plus the same local TLS fixture used by the direct comparison. The fixture
  transport maps a fixed public DNS test result to loopback only inside the
  benchmark; production has no such bypass. The benchmark does not measure
  public-network latency, native CLI startup, vendor service time or production
  throughput. Its own output records sample counts and control-plane counts.
- Real PostgreSQL tests cover the effective scope/precedence, mutation stop,
  original/successor credential lineage, current metadata and final claim
  snapshot fences. They must execute in the PostgreSQL 17 CI lane; an executor
  that cannot start PostgreSQL does not turn a skipped DB test into evidence.

Native provider and GitHub operations still use their original direct path.
There is no new per-operation Mikka authorization RPC or SQL in those paths.
The third-party data plane adds one forwarding hop and no database/remote
authorization lookup. Claims with configured saved variables recheck metadata
at their final fence; protected runs recheck authority and metadata during the
existing heartbeat. These control-plane costs are separate from API-call cost.

## External acceptance workflow

`task-secret-acceptance.yml` runs after a successful official runtime release
only when the first-parent source diff touches the Secret implementation or
its acceptance driver. Before checkout and before each existing OIDC credential
read, it verifies the official workflow, repository, current main, source and
run attempt. The unique release artifact, archive digest, published templates,
computed worker hash and public Web build must agree. An unrelated release does
not start model tasks, and an incomplete publication cannot supply guessed pins.

The ordinary native cases use the existing smoke account and fixed Claude Code/Codex
subscriptions. Each owns one uniquely named branch and draft PR in
`alexj11324/Mikka-handoff`, then verifies closure and branch deletion without
merging. A separate disposable E2B fixture holds independent random test keys
and a synthetic canary. The task executes the actual bridge and egress source,
but this is not a production Secret Store/claim test. Its timing baseline is a
public unauthenticated route on the same fixture, not a production vendor or
native-model before/after measurement. Ambiguous Git cleanup retains its exact
target and Mikka Issue for recovery instead of deleting an unverified resource.

Ordinary writable task cases do not enable the opt-in runtime diagnostic
collector. Their native tool, post-tool reply, terminal state, subscription,
worker/template, Git and HTTP proofs remain required. Missing diagnostics are
not a zero-RPC measurement; malformed or truncated diagnostics are unusable.
These no-submit cases require the ordinary thread to end as `stopped` with all
native proofs; they do not assert an unexposed stop reason or Factory completion.
The automatic report references the exact official release's strict
authorization census, with one candidate subscription sample per harness.
Manual runs without that release attestation report this census as unavailable.

A separate serialized job reuses the existing `run-observability` driver and
its original ACME demo account for the full Factory Artifact flow: execution,
independent review, exact artifact bytes and normal Owner acceptance. It uses
both fixed subscriptions without browser submission or settings preparation;
existing profile, subscription and paid-fallback preflight blockers remain.
The original driver selects that account's personal workspace without restoring
the prior workspace selection. It retains its existing temporary Profile/model
cleanup and does not change credential values or scopes. Manual Factory runs
also require the explicit `factory_acceptance` input.

Read the native and Factory reports together. The native report's remaining
evidence list identifies coverage outside that driver; a separate Factory
receipt can satisfy that item. Ordinary mode does not certify production-store
canaries. Neither mode certifies PostHog absence or arbitrary screenshots,
checkpoints, and templates.

### Run the production-store canary

Use this mode to test a newly generated private Secret through the deployed
store, actual task claim, and inherited `MIKKA_SECRET_ENDPOINTS` bridge. It
changes one synthetic entry owned by the normal smoke account. Effective
personal Secret changes stop that owner's active runs across all workspaces,
so the shared account needs an exclusive acceptance window.

Before starting, review the exact source and record the source, owner lane,
start, and expiry of that window in an issue #1752 comment. The existing
Infisical workload must be able to read `MIKKA_DATABASE_URL` from `prod:/vercel`.
The driver uses that binding only for `READ ONLY` transactions. Existing use of
the identity elsewhere does not replace checking this job's actual credential
read result.

1. Select the workflow's manual `execute` mode with the exact application,
   worker, worker-source, and official-template pins. Keep each selected
   subscription on its fixed small model.
2. Set `production_canary` to `true`. Supply `canary_window` as a JSON object
   with `comment` containing the exact issue #1752 comment URL and `expiresAt`
   containing the UTC ISO timestamp with milliseconds. The window must end
   within 45 minutes of execution starting. Automatic release-triggered runs
   never select this mode or read the database credential.
3. Check the job's full-owner idle proof. Before each Secret mutation, the
   driver reads every unfinished run for the signed-in owner, without a
   workspace, date, or row limit. Only the exact active run being deliberately
   revoked can be present during rotation. Other writes require no unfinished
   owner run. A mismatched identity, unknown status, timeout, expired window,
   or foreign active run blocks the write. This read is not atomic with the
   following human API mutation; the reserved window remains necessary.
4. Review both phases for each available subscription. The first task uses
   its inherited bridge to make an authenticated synthetic upstream request.
   The runner rotates only its recorded private Secret, then requires an
   expired lease and a stopped native run within 90 seconds. A second task
   must claim the rotated value and complete ordinary Git/gh cleanup, the
   installed SDK request, HTTP policy negatives, bounded canary scans, and a
   tool result followed by a reply. The fixture cannot mint grants for these
   production-claim cases. A failed subscription remains a separate result.
5. Confirm the cleanup receipt. The runner first stops and retires its own
   task fixtures, deletes only the newly created Secret ID, and verifies its
   metadata is absent. It also tears down the disposable upstream VM, archives
   its Profiles, restores the prior workspace, and signs out.

`production-task-secrets-report/canary-journal.json` records the fixture ID,
source, private entry ID and name, mutation acknowledgements, and idle proofs.
It contains no value, database URL, session, or capability. A lost create reply
is reconciled only against this invocation's unique metadata and pre-existing
ID inventory. If cleanup encounters another active task, a changed entry, or
an expired window, it retains the exact target as deferred. Reserve another
window and verify that target before completing cleanup; do not stop other
tasks or delete entries selected only by a broad name prefix. An interrupted
job's journal is a recovery record, not a successful cleanup receipt.

The report distinguishes the production claim and rotation evidence from
remaining checks: raw capability replay after expiry, cross-owner/workspace/
repository claims, actual local and self-hosted claims, PostHog and image/
checkpoint inspection, the separate Factory receipt, and complete RPC/SQL
census with same-version native startup distributions. Ten paired HTTP samples
compare the protected path to the same fixture's public route; they do not
measure native-model startup or a production vendor's latency.

## Evidence required before completion

Use only generated canaries, an isolated database, and disposable test state
for leakage tests. Record the exact application and worker revision. Verify
scope precedence and negative owner/workspace/repository/run/device/attempt
cases; expiry, renewal refusal and rotation; origin, path, header, redirect and
DNS refusal; SDK/direct compatibility; subprocess environment and journal /
checkpoint absence; and successful authorized upstream use. A raw string mask
alone is not proof of confidentiality.

Measure admission separately from steady-state third-party request overhead.
Report sample count and p50/p95 on a fixed version and environment, with SQL and
additional authorization RPC counts. Do not combine #1505's historical cold
startup measurements with this experiment. Native model/GitHub paths must gain
zero per-call authorization RPCs. Production external-service acceptance still
requires the official Claude Code and Codex subscription paths, and the real
GitHub delivery flow; synthetic tests are not substitutes.

This document starts as a design and source audit. Passing evidence, workflow
links, version pins and remaining gaps are recorded on #1712 and its PR as the
implementation is verified. No production runtime protection is asserted by
this document alone.
