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

Capabilities expire no later than the current run lease (90 seconds). Renewal
uses the existing authenticated device heartbeat and only a successfully
renewed, matching claim; no new polling or provider/tool preflight is added.
Stopping or revoking a run prevents renewal. The running task's bridge closes
when its existing stop signal arrives. **A copied bearer capability can retain
its already granted authority until that short lease expires.** An in-flight
upstream effect cannot be recalled. The implementation and tests must expose
this bound instead of claiming instantaneous distributed revocation.

Changing or deleting a Secret or its delivery policy invalidates the affected
run authorization, so an old encrypted grant cannot renew indefinitely. A new
claim re-resolves current values and policy. A retry or a different device must
not inherit a previous claim's grant. Capabilities and direct-mode values stay
out of journals, reusable templates, checkpoints, artifacts and diagnostics.

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
  bridge and two real SDK subprocesses, renews the opaque grant between calls,
  and reads the actual journal/outbox files. Neither canary nor capability is
  in the child environment or persisted journal. Native credential options
  retain their existing path. The in-test upstream is explicitly synthetic.
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
