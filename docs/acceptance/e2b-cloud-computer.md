# E2B cloud computer: implementation and live evidence

Date: 2026-10-26. Tracks #172. Branch: `codex/e2b-cloud-computer-172`.

## Implemented

- Real E2B SDK control plane, plain Linux template with 2 CPUs / 2048 MB,
  Xvfb/Openbox/Chromium/x11vnc and checksum-pinned MIT cua-driver-rs 0.38.0.
  No Cua Spaces image, spacesd or perception service.
- Persistent owner/workspace-bound `bots`, `cloud_machines`, `bot_desktops`.
  Separate bot IDs, no reinterpretation of an agent/run ID as a bot ID.
- Session/active-workspace routes: bot create/list, computer state, wake,
  viewer, takeover and handback. Mutations require matching Origin.
- Shared `@mikka/protocol/computer` Zod schemas now validate route inputs and
  real browser state/viewer responses. Handler tests cover session denial,
  Origin checks, owner injection, malformed inputs and provider-error redaction.
- One machine per workspace, currently restricted to one account owner.
  Multi-owner execution is rejected, not silently treated as isolated.
- Two-minute signed viewer grants, server-enforced view-only VNC, five-minute
  renewable control leases, generation-based revocation and active socket closure.
  VNC uses Unix sockets and Chromium exposes no CDP TCP listener; the signed
  viewer gateway is the only desktop ingress. E2B was observed forwarding even
  loopback TCP listeners publicly, so loopback binding is not a security boundary.
- Default 15-minute provider pause lifecycle; viewing/waking refreshes activity.
  Control state survives app restart in PostgreSQL. Provider pause is checked
  when reading computer state.
- Run-to-Bot binding storage enforces matching owner/workspace through foreign keys and only admits queued runs; the bind operation serializes with run claiming. The local daemon claim path rejects bound runs rather than running them without the Bot desktop. Binding is not yet wired to dispatch or a cloud worker.
- Reused #161's exact-operation broker/driver/proxy and regression tests; cloud display is bound to the trusted grant and included in the approval digest.
  Driver display selection is per child process, avoiding global DISPLAY races.

## Actually executed

Infisical Universal Auth and an in-memory read of `dev:/vercel/E2B_API_KEY`
succeeded. The E2B API accepted the key. No key was committed or sent into a
sandbox, model prompt, screenshot or test report.

The initial base sandbox had only 512 MB. Two Chromium processes caused resource
pressure and command timeouts; it was not accepted as the desktop specification.
The dedicated 2048 MB template was then built and tested.

In a real E2B instance:

1. Two concurrent Xvfb desktops returned actual screenshots through the pinned
   driver and exact-operation broker. An approved click dismissed only desktop
   one's dialog; desktop two remained unchanged. Replayed approval was rejected.
   Before/after screenshots were inspected.
2. An actual RFB handshake and raw framebuffer pixels were received through the
   gateway. A view token could not move the pointer; a control token could.
   Invalid/expired/other-owner grants returned 401. Changing the lease generation
   closed an already-open control socket.
3. E2B pause/resume preserved Xvfb, VNC and Chromium PIDs and a workspace file.
   The complete RFB/permission probe passed again after resume.
4. The task OS user could neither invoke sudo nor read the infrastructure signing
   key. The template removes the base image's effective sudo access.
5. `store-live.ts` used the actual production store and E2B provider, with an
   isolated PostgreSQL schema: provision → persistent bot → viewer → takeover →
   handback → pause → new store instance → wake → read preserved file. Cross-owner
   access and control without takeover were rejected. Its sandbox/schema were
   removed in cleanup. This is not a mocked provider test.
6. Public-ingress testing found that E2B forwards localhost TCP ports. The final
   runtime uses Unix VNC sockets, explicitly disables both IPv4 and IPv6 RFB
   listeners, and removes Chromium's CDP TCP listener. The live store probe was
   rerun: anonymous public viewer access returned 401, public CDP returned 502,
   no x11vnc/Chromium TCP listeners existed, and real pixels/view-only/control
   still passed through the Unix socket gateway.

Database regression also ran against real PostgreSQL 17: idempotent migration,
concurrent allocation, account/workspace denial, single-owner machine admission,
control generations and recovery after a failed gateway synchronization.

## Reproduction

Build from the repository root with the Python E2B SDK:

```sh
python scripts/e2b/build-template.py --name mikka-cloud-desktop-NEW_VERSION
```

The build packages the daemon and protocol from the selected committed Git
revision (`--source-ref`, default `HEAD`), records its full SHA in the template,
and installs the locked dependencies. It does not copy the working tree or
local environment files. Use a new versioned name so an existing alias is not
silently replaced.

Provide `E2B_API_KEY` only to the control-plane process. Configure the resulting
`E2B_COMPUTER_TEMPLATE` in that deployment's Infisical scope. The test build
created template `wt4zieke417b086z059d`; template aliases are mutable, so rebuild
from the reviewed source for release rather than treating the alias as a digest.

The live store check needs a disposable loopback Postgres URL and explicitly
provisions billable E2B compute (cleaned up afterward):

```sh
node --import ./scripts/server-test.mjs --import tsx scripts/e2b/store-live.ts
```

Use `COMPUTER_TEST_DATABASE_URL` for that isolated database. The script refuses
non-loopback database hosts. Never substitute production application data.
The desktop and viewer probes run only inside an empty disposable sandbox; their
scripted fixture approvals are not a production auto-approval policy.

## Not yet accepted / release blockers

This increment proves E2B desktop infrastructure and persistent lifecycle. It
does **not** complete every #172 requirement or authorize enabling the feature
for all users:

- The current main application still lacks the full Bot/chat/thread relationship.
  The new Bot API is not yet wired into that existing UI model. No authenticated
  product browser session was available in this task; no deployed UI pass is claimed.
- Hosted daemon registration, cloud task dispatch, browser MCP/desktop MCP
  injection into real model runs, takeover pausing those tool calls, run-scoped
  approvals and `data-computer` chat events remain to be integrated. The broker
  has been tested in the sandbox, not connected to the product approval ledger.
- Subscription OAuth/CPA/native Codex/Claude foundations have been selectively
  integrated, but no real provider inference or subscription-connection acceptance ran.
- No cross-profile authentication cookies are copied. Multi-owner isolation and
  authorized same-owner session reuse need their own acceptance.
- Both additive computer migrations were applied and recorded in the production
  application database after its target was verified against Infisical and Neon.
  The production template configuration is present; application deployment,
  feature enablement and authenticated product acceptance remain outstanding.

Keep the cloud-computer feature flag off until those product-level paths are
integrated and exercised. A successful SDK/desktop probe alone is insufficient.

A subsequent disposable real E2B test reran two-display screenshots, an approved click and replay denial using the broker’s display-bound grants. The sandbox was deleted after the test. The run binding migration and owner/workspace/queued-state tests passed against isolated PostgreSQL 17. Neither test establishes hosted daemon dispatch or model-run integration.

## Production-scoped infrastructure check

Using the E2B configuration from Infisical `prod:/vercel`, the actual store and
provider created a disposable E2B sandbox, obtained real framebuffer pixels,
verified unauthorized control denial without marking the machine as failed,
performed takeover and handback, paused and resumed the machine, and checked
the retained file. The temporary sandbox was deleted. This used an isolated
local PostgreSQL schema: it does not establish that a deployed production app,
a model run or a subscription connection has passed acceptance.

## Subscription custody integration in progress

The CPA custody worker, owner-scoped subscription APIs, protocol and migrations
are selectively reused from draft #206. The retired `/api/agent` entry point
and the old settings UI were not restored. `MIKKA_BYOS_ENABLED` and enrollment
remain disabled pending worker build, integration with the current Bot harness,
provider-specific validation and real user OAuth consent. The local model and
enrollment tests use synthetic providers; they do not establish production
subscription inference, hosted CLI operation, or computer-task execution.

The production E2B template was also tested in a disposable sandbox with Docker
and bubblewrap installed: a root-only Unix Docker socket launched a read-only,
network-disabled, capability-dropped container, and the task OS user could not
access that socket. This proves the runtime prerequisite only; it does not
prove hosted CLI, provider inference or E2B task dispatch. Fresh migrations and
both historical BYOS migration-name sets were tested on disposable PostgreSQL;
existing database ledger entries are preserved and equivalent SQL is not replayed.

A dedicated E2B worker template `1rk83v3fyo1xs4n6x4vk` was built with the
production-scoped E2B key. The actual store/provider started its container service twice, verified the dedicated non-root runner
can access the socket while the task account cannot,
then exercised real framebuffer/control and verified the container service
again after E2B pause/resume. The disposable sandbox and schema were removed.
This template is not yet selected for production and is not a hosted-worker
or model-inference acceptance.

The native Codex and Claude subscription adapter changes from #206 were
three-way merged with current main instead of replacing its existing adapter
behavior. Local adapter regressions and subscription protocol/adapter tests
passed with fixtures. Real provider consent, hosted native CLI inference,
computer tool execution and the complete product flow remain unverified.

The subscription broker's hosted-runner transport was adapted without removing
mainline run checkpoints or native Coordinator support. Device claim and native
binding publication are one database transaction; cloud-desktop-bound runs still
fail closed until the E2B worker and computer approval tools are wired. Codex's
synthetic hosted-container test passed locally; the Claude test timed out during
the separate verification container on this vfs-backed host, including on a
standalone retry. No timeout or assertion was relaxed, and leaked disposable
containers from those failed tests were removed. Neither result is real-provider
acceptance.

A device-authenticated exact-operation review ledger now checks the run owner,
workspace, bound Bot and display before recording a review. A session-authenticated
owner can approve or deny a single operation; altered digests, cross-workspace
decisions, stale/cancelled runs and replay are rejected. Run-wide approval is
not implemented and fails explicitly. The daemon transport can sync snapshots and apply matching decisions, with a
request-only MCP proxy regression test. A cancellable polling loop retries transport
failures without approving calls; when a broker is supplied to the daemon, its
polling starts after registration and stops on shutdown. Actual cloud worker
provisioning, hosted-run injection and chat events remain unwired, so this is
not end-to-end approval acceptance.

## Real E2B hosted-runner fixture

On 2026-10-26, a disposable E2B sandbox created with the production-scoped E2B
configuration ran both hosted-runner fixtures from commit `8419e15` successfully.
The fixtures use synthetic Codex and Claude CLIs and a fake provider; they verify
the actual container runtime and adapter plumbing, not provider OAuth or inference.
The first 2 GB worker template ran out of free disk during the full test setup.
The subsequent test used the separate template `27dk2k0wg8y19b3z91g7` (4 GB RAM,
at least 16 GB free disk), pinned Node and the fixed container image. The test
sandbox was deleted. This worker template is not selected for production.

A later template (`9v29kepal8z4m2e5qjdb`) packaged the daemon from immutable
commit `fc92ebf`, installed the pinned dependencies and started it as the
dedicated non-root runner in a real E2B sandbox against its in-memory server.
The runner reached online state, its code was not writable, and the task OS
user could not read its device credential. The sandbox was deleted. This is
a packaging/startup smoke test, not an application dispatch or provider test.

The next template (`o76gkx1s4jt7cv50bdd0`) packaged commit `1f3777b` and added
the official pinned Codex 0.163.0 binary. In disposable E2B sandboxes the daemon
reached online state against an in-memory server, and hosted-runtime preflight
detected both Codex and Claude Code. These tests do not use provider credentials
or establish inference; both sandboxes were deleted.

The template `76a65pofcj9rwthrbam3` packaged commit `eef59af`. A separate live
test started its hosted worker through the control-plane handoff, registered it
against a synthetic HTTPS device service, confirmed that a second start reused
the same device, and verified the task account could not read the credential.
The device service and local PostgreSQL observer were synthetic; no deployed
application authentication or real task was exercised. The sandbox and schema
were deleted. The worker-provisioning lease migration is recorded in dev and
production databases.

The same synthetic registration test now exercises a guarded real CUA driver:
another Bot is rejected, the task account cannot read or alter the desktop lease,
person-controlled desktops deny agent input, and handback permits it again.
A shared process lock held across exec also makes takeover wait for an active
operation before granting the person control. The E2B sandbox was deleted. The
guard is infrastructure-tested and is injected into the hosted fixture runs
described below; no real model inference has been tested.

The request-only computer MCP has also been injected into hosted Codex and
Claude Code fixture sessions in real E2B containers. Both synthetic CLIs held
their click until the matching Bot/display review was approved, then continued.
No real model inference or deployed product session was involved.

The `e54444d` worker template (`gsn1ued0tiywwmwwkjxi`) also completed a full
synthetic Bot task in E2B: a scoped worker registered with a simulated HTTPS
device service, the claim helper bound a synthetic task, and the hosted fixture CLI
requested a screenshot and a click. Each operation waited for its matching
database approval before the guarded driver executed it; the fixture then
submitted the task. The service and model were synthetic, and the database
observer simulated approval; this is not a signed-in product, real provider, or
production deployment acceptance. The sandbox and local schema were deleted.
The test was repeated with a run-wide grant: the first screenshot was approved
for that run, and its later click was automatically approved on the same Bot
desktop. A different run on the same desktop still needs its own decision.

The scoped task endpoint now queues a run and its Bot binding in one database
transaction. A trusted cloud worker emits a `data-computer` event, and the
server checks it against the scoped device and stored Bot binding before the
thread can render its computer card. PostgreSQL and source tests cover these
bindings; the signed-in UI and deployed request path still need acceptance.

Template `jqy5eq2ckjt1pw48uxfj` (worker source `43948df`) was tested with a
synthetic credential replacement while a real E2B task was awaiting approval.
The worker re-registered with the replacement, then continued through approval
and submission. This does not exercise the deployed heartbeat endpoint or a
real provider credential. PostgreSQL tests separately cover renewal isolation,
concurrent requests and retry after a lost response. The sandbox was deleted.

Template `hrtv52tbqrefferq6m27` (worker source `8c46e2d`) completed the same
synthetic task with the Bot-bound computer event, run approval and credential
renewal. Approved screenshot, click, Tab and scroll operations ran through the
guarded driver; an X11 event listener confirmed that Tab and the scroll reached
the desktop window. This remains a synthetic service/model test, not signed-in
product or provider acceptance. The sandbox was deleted.
The test was then repeated using `ensureBotRuntime` to create and reuse the
Bot's real E2B working tree and internal executor records before queuing the
task. The service, subscription binding and model remained synthetic. The
`bot_cloud_runtimes` migration is recorded in development and production.

The integrations settings now expose a user-driven subscription ceremony when
the backend is enabled: Codex uses the provider's device page, and Claude uses
the existing state-checked callback handoff. The page keeps ceremony data in
memory and validates provider URLs; disconnect reports the limitation of
provider-side revocation. This UI has source-level checks only. Actual provider
consent, browser flow, and both subscription execution paths remain unverified.

Development and production databases also have the additive cloud-device-scope
migration recorded. Isolated PostgreSQL tests exercised scoped worker credentials,
expiry validation, rotation and the Bot's pending-review state. The worker
credential provisioning and review polling are wired to hosted fixture runs;
they still require an actual user-initiated Bot task before product acceptance.

The production-scoped infrastructure test was extended to create a disposable
Bot/run binding in local PostgreSQL, approve the broker's exact request, and
execute a real CUA click in that Bot's E2B desktop. After pausing and resuming,
the test verifies a control viewer can move the pointer to its previous client
coordinate even though CUA moved it in between. This exposed x11vnc's duplicate
coordinate optimization, which can otherwise leave a subsequent click at the
wrong position. Starting the control server with `-always_inject` fixed the
repeated-coordinate regression in the live test. The run was synthetic and does
not establish production application or model acceptance.
