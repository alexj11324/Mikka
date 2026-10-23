# Computer use: incomplete integration and compatibility boundary

This branch is a Draft for #148, not a completed remote-desktop integration.
The ten unit tests use scripted wire/model fixtures; they are not a real CUA
container, actual GUI editor, live-model, or protocol compatibility test.
No model API keys, production services, or local databases are used in those tests.

## Implemented boundary

- Adds `computer_use` to the existing shared protocol permission table, default
  `ask`; old policy payloads remain compatible. Read-only policy denies it.
- Persists workspace (not per-user) choices in `agent_settings.permissions`,
  resolved by the same `resolvePermissions` implementation as run policy.
  Missing/invalid choices remain `ask`; unavailable membership/policy omits tools.
  `PUT /api/agent/computer/policy` requires a session, same-origin JSON, and an
  active workspace admin. It changes only `computer_use`, retaining other keys.
  The protected settings UI is not modified or claimed to be wired.
- The configured desktop is explicitly bound to one `CUA_WORKSPACE_ID`.
  `CUA_DESKTOP_URL`, `CUA_DESKTOP_TOKEN`, and that workspace UUID must all be set
  by deployment configuration. These variables are not collected from the model.
- Active workspace membership is required before exposing tools. Rechecked at
  enqueue and atomic claim. Workspace policy deny cancels pending requests.
- Model tool calls only enqueue requests. An authenticated approval POST carries
  only the request ID, session ID and boolean decision. It cannot change arguments.
  The ledger binds owner, workspace, session, normalized tool/args, endpoint/token
  fingerprint and a five-minute expiry. Conditional SQL admits one decision;
  failed/uncertain operations cannot be replayed or automatically retried.
- Workspace row locking serializes policy changes and approval claims. Revocation
  cannot undo an already admitted/in-flight external action.
- Even workspace `allow` currently retains the narrower per-operation approval;
  it does not manufacture user consent. `deny` blocks, including pending approvals.
- Screenshot bytes and endpoint credentials are never stored in policy/request
  rows. Operation text is stored for exact review; credential entry is not a
  supported computer tool use. Do not send passwords/tokens in `computer_type`.
- Approval cards poll during a live model tool, display exact saved arguments,
  and queue an owner decision, not an execution-success claim. The same pending
  tool atomically claims the approval and returns transient PNG image content
  directly to the next AI SDK model step. No screenshot/result is stored in SQL.
  Stop, deny, expiry and loss of membership fail closed; an uncertain network
  dispatch consumes the approval. Each approval wait is bounded to 120 seconds
  within the Agent route’s existing 270-second total. This is covered by a
  live-stream scripted AI SDK model + HTTP wire fixture, not a real CUA desktop.

## Compatibility and licenses checked

Checked upstream `trycua/cua` at commit
`27d8da9fd94056bd73892183531579396aafb2f9` (2026-10-23).
The parent [#147](https://github.com/alexj11324/Mikka/issues/147) explicitly says to use only cua-driver’s MIT parts and not install
cua-perception. It does not state that every component of an external image must
be MIT. The separately bundled spacesd service has its own FSL terms. Those expressly
permit this bounded internal CI use, not a general commercial service; the
driver’s MIT license does not replace that component license. A repository/image MIT label alone does not
establish the bundled component's license. The component evidence below concerns
copying/distributing it; connecting to an independently operated external service
is a separate terms/deployment decision, not a legal conclusion or permission.
Exact provenance: [spacesd v0.1.0 release](https://github.com/trycua/cua/releases/tag/cua-spacesd-v0.1.0),
[component license at first commit](https://github.com/trycua/cua/blob/9166817485ae53f3966935c13878a8196d79a399/libs/cua-spacesd/LICENSE),
and [current component license](https://github.com/trycua/cua/blob/27d8da9fd94056bd73892183531579396aafb2f9/libs/cua-spacesd/LICENSE).
No checked MIT-era spacesd artifact has been identified; the requested image is
not claimed unavailable.

| Artifact / protocol | Evidence | Status for this request |
| --- | --- | --- |
| Requested `trycua/cua-xfce:0.3.0` | Public registry index `sha256:e188a008084e1034f5ff003e7983c58596d9c0e47adf5c34078b362aad2a57e7`; Linux amd64 image `sha256:0ac954ee74d5a3878484ddf5e4df7e83a1fdeeef1ec9a8d8744b76afcd0187fb`; revision `5da241ac4b4ff2cb165f3c48401391674d7f1dbd`. Inspected registry config/history exposes 3211 and explicitly installs spacesd v0.1.0. | Image exists, but includes the separately FSL-licensed spacesd component despite an overall MIT image label. Exact bundled FSL terms expressly permit internal use/access; the originally requested isolated CI job is enabled on that scope. Public commercial hosting/distribution is not authorized or certified. Actual endpoint acceptance requires exact-head service results. |
| Current documented `trycua/xfce-cua` | `libs/xfce-cua/README.md`: driver-only runtime, no spacesd, no auto-start; example starts driver with bypass-approval flag. | Cannot supply the requested endpoint as documented. Not silently substituted or started with bypass approvals. |
| `cua-spacesd` v0.7.0 / current | `libs/cua-spacesd/LICENSE` is FSL-1.1-MIT, copyright 2026 Cua AI, Inc. Current generated HTML5/TS bindings also component licensed. | No FSL source/generated bindings copied or bundled. A separate service's operation/terms are not granted by MIT driver licensing. |
| First spacesd directory commit `9166817485ae53f3966935c13878a8196d79a399` (2026-10-01) | That exact `libs/cua-spacesd/LICENSE` is already FSL-1.1-MIT. Parent `93d0f7af24b1561f98f6a85cd20ca2b35f37db35` has no spacesd directory. | This checked history does not supply a pinned MIT-era spacesd. No claimed compatible MIT binary. |
| `cua-driver-rs-v0.38.0`, commit `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19` | Rust workspace explicitly MIT; driver crate inherits workspace license. Root MIT copyright 2025 Cua AI, Inc. Published Linux/macOS binary assets exist. | Candidate for #149 only, not spacesd's gRPC-Web endpoint. Release archive SHA256SUMS checked; binary reports 0.38.0; MCP --help verified, including runtime ownership and standard/bounded/unrestricted modes. Real driver evidence is tracked separately in stacked #161; it does not prove remote endpoint compatibility. Never include cua-perception/OmniParser. |
| Independent `lib/cua/grpc-web.ts` | Locally authored bounded unary codec with scripted local HTTP fixtures and explicit gRPC success/error handling; no upstream implementation dependency. | Compatibility candidate, not real CUA validation. Pin/test against an applicable service/protocol before production. |

## Database effect and CI

`20261023185539_computer_requests.sql` targets `DATABASE_URL`, the workspace DB.
It creates new small `agent_settings` and `computer_requests` tables and a new
owner/session index. It is idempotent, uses no rewrite of existing tables, stores
no endpoint credentials or screenshots, and cascades on workspace deletion.
Rollback before use: drop the two new tables. Approval text should have a defined
retention/deletion policy before production enablement; this Draft adds no cron job.

Only CI's existing Postgres 17 `mikka_e2e` may execute database tests. The added
migration test uses an isolated transaction/schema, applies the migration twice,
checks default settings/owner/session/target/replay and rollback cleanup. It does
not alone establish authenticated HTTP route or policy-race E2E coverage.
`computer-store-ci.test.ts` separately uses the actual Drizzle store/policy
implementations with an injected active-membership/workspace-lock guard, scoped
PG17 schemas and concurrent connections to cover admin enforcement, owner/session/
target binding, approved claim races, deny revocation and stopped approvals.
It does not import the Next/auth runtime or prove end-to-end session auth.
The added browser fixture verifies native HTTP auth rejection/strict decision
payloads and that exact-operation review stays visible while the model waits;
its fake stream is not remote service validation.
`20261023185540_computer_live_approval.sql` replaces only the new approval-ledger
status constraint to admit approved/cancelled; it stores no output and is
idempotent. Drain live streams and remove new-state rows before rolling it back. Existing
migration runner/CI overlap with #84/#86 and #115 must be reconciled before merge.

## Remaining acceptance

1. Run only the reviewed isolated internal-CI service use described in
   `docs/ci-prepared/cua-service-terms.md`; FSL explicitly permits internal use,
   but public commercial service/distribution is a distinct factual question.
   Do not copy FSL source or change the requested endpoint/protocol.
2. Verify the independent wire codec against that actual service, including auth,
   failure/trailer handling, scale/bounds and Unicode/chords.
3. Live screenshot-to-scripted-model continuation is implemented and fixture-tested;
   actual requested-service + editor/readback remains open. Plain model text
   saying “approved” is never consent. Real-model/real-machine final signoff is
   Alex’s step under #147, not a CI API-key dependency.
4. Add CI's actual container + editor input/screenshot assertions and real policy,
   membership, cancellation, concurrent approval and resumption route tests.
5. Wire workspace controls through the protected settings UI's owner, not by editing
   those files here. The separate stacked #149 local-driver path is described below.

## Exact remote-service CI scope

The requested pinned image contains spacesd v0.1.0. Its exact FSL terms expressly
include internal use/access. The original #148 request covers a disposable
loopback-only GitHub CI test with no provider, secrets, perception, image
redistribution or public service. No concrete term preventing that test was
identified; no second approval is required merely because spacesd is non-MIT.
No FSL implementation/generated bindings are copied into Mikka. The exact terms,
provenance and limits are in `docs/ci-prepared/cua-service-terms.md`. Future public
commercial hosting is not certified by these CI results. Real service evidence
must come from its exact-head CI job, not loopback fixture tests.

## Local driver (#149, stacked on #148)

The local path uses the MIT `cua-driver-rs v0.38.0` release, not spacesd or the remote image. Detection requires the pinned version and records the executable SHA-256. Device registration and heartbeat report `computerUse` separately from the model harness list. Existing clients/devices default to unavailable. The additive `devices.computerUse` JSONB migration has a constant false default and is idempotent; deployment runs it against the app database, with ordinary migration serialization required. No local/dev/production database was used for validation.

Claude, Codex and Cursor receive a second `computer` MCP server only when detection succeeds and the run's explicit computer-use permission is ask/allow. They receive Mikka's request-only proxy, never raw driver MCP. This avoids treating their existing bypass/never native approval settings as authorization. The tool subset is deliberately screenshot, click and exact text input; arbitrary driver tools, output paths, scope changes and extra arguments fail closed.

Each operation waits in the same MCP tool call for an owner decision. Use `mikka daemon computer pending` locally to inspect run, executable fingerprint, normalized operation, expiry and review digest, then `mikka daemon computer approve <id> <digest>` or `deny <id> <digest>`. These use the existing secret-handshaken owner RPC; the model-facing socket cannot list or approve. The run must remain live, the device signed in, the permission not denied/read-only, and binary bytes unchanged. A five-minute request is claimed before execution, never refunded after failure/uncertainty, and is discarded on daemon restart. After approval the actual driver result returns to the pending model call, not a textual "resume" instruction. Desktop output is untrusted data, not new authorization.

The local Unix socket is scoped to the OS owner and the daemon's protected secret. This is not a new hardened multi-user OS boundary or a grant for a remote collaborator to operate the device. The local owner CLI remains a fallback; a second owner web surface at `/devices/approvals` now reviews daemon snapshots through the existing authenticated device HTTP link. The page displays the exact call, executable fingerprint, run and expiry. The same-origin session decision queues only an ID, digest and approve/deny boolean; the daemon matches it to a still-pending request and rechecks run policy, expiry and binary bytes before execution. No screenshot or tool result is uploaded through the review endpoint. The owner sees “queued”, not an invented execution success. Real signed-in Claude/Codex/Cursor reasoning after a desktop result remains Alex's final check, not an implementation prerequisite. Prior-head macOS CI performed the real native-dialog screenshot/approved click/second screenshot; that runner evidence does not configure or certify another Mac’s OS permissions. Prior-head evidence does not certify the newly integrated parent; keep Draft until integrated-head CI/browser/native acceptance is complete.

Linux validation starts isolated Xvfb and xmessage, asks for a screenshot through the broker, then separately approves a click on its OK button and asserts that the actual desktop process exits. It uses the checksum-pinned published driver, not a fake protocol implementation. Separate unit/RPC tests cover absence/version mismatch, permission denial, normalization, argument binding, replay, expiry, revocation, failed execution, request-only proxy and authenticated owner review.

### Web review ledger (#149)

`20261023185542_local_computer_reviews.sql` creates a new short-lived operation ledger. It references devices/runs with cascading deletes and has an owner/expiry index; no existing data rewrite or backfill. Rollback before use is dropping only this new table. Normal migration serialization/brief metadata locks apply. A five-minute daemon snapshot is hash-bound and never extended by the web. Device authentication must own the device and each live run. Browser authentication must own that run/device and have a fresh device snapshot. Replays, extra fields, changed arguments/digest, cross-owner requests and stopped/expired runs fail closed. Only pending operation text/metadata is stored, not screenshots, execution results or tokens; credential entry remains unsupported. Expired owner rows are deleted on review reads/sync, and a device's no-longer-pending snapshots are removed at next sync. There is no background cleanup job or production retention guarantee while offline.

The browser regression uses only CI ephemeral Postgres to exercise real authenticated device and browser HTTP routes, owner decision rendering, changed arguments, replay and stopped-run rejection. A separate scripted MCP client verifies that the original blocked call receives a result and submits its next screenshot/click operation; this is not a signed-in model reasoning test. Linux/macOS native-driver evidence is a separate real-driver test, not proof those providers used this web route.
