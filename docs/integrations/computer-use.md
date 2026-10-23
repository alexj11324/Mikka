# Computer use: incomplete integration and compatibility boundary

This branch is a Draft for #148, not a completed remote-desktop integration.
The seven unit tests use scripted wire fixtures; they are not a real CUA
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
  scripted AI SDK model + HTTP wire fixture, not a real CUA desktop.

## Compatibility and licenses checked

Checked upstream `trycua/cua` at commit
`27d8da9fd94056bd73892183531579396aafb2f9` (2026-10-23).
The parent [#147](https://github.com/alexj11324/Mikka/issues/147) explicitly says to use only cua-driver’s MIT parts and not install
cua-perception. It does not state that every component of an external image must
be MIT. The separately bundled spacesd service still requires an applicable
component/use decision; the driver’s MIT license does not answer that question. A repository/image MIT label alone does not
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
| Requested `trycua/cua-xfce:0.3.0` | Public registry index `sha256:e188a008084e1034f5ff003e7983c58596d9c0e47adf5c34078b362aad2a57e7`; Linux amd64 image `sha256:0ac954ee74d5a3878484ddf5e4df7e83a1fdeeef1ec9a8d8744b76afcd0187fb`; revision `5da241ac4b4ff2cb165f3c48401391674d7f1dbd`. Inspected registry config/history exposes 3211 and explicitly installs spacesd v0.1.0. | Image exists, but includes the separately FSL-licensed spacesd component despite an overall MIT image label. Not pulled/started: applicable FSL service use has not been resolved; this is not a claim that #147 requires a wholly MIT image. Real editor/input/screenshot E2E remains open. |
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

1. Resolve the requested pinned image's bundled FSL service versus MIT-only
   scope, or identify an appropriately licensed endpoint service. Do not import FSL code or change image/protocol by accident.
2. Verify the independent wire codec against that actual service, including auth,
   failure/trailer handling, scale/bounds and Unicode/chords.
3. Live screenshot-to-scripted-model continuation is implemented and fixture-tested;
   actual requested-service + editor/readback remains open. Plain model text
   saying “approved” is never consent. Real-model/real-machine final signoff is
   Alex’s step under #147, not a CI API-key dependency.
4. Add CI's actual container + editor input/screenshot assertions and real policy,
   membership, cancellation, concurrent approval and resumption route tests.
5. Wire workspace controls through the protected settings UI's owner, not by editing
   those files here. Keep separate #149 daemon integration incomplete until its
   reported driver and CLI-specific MCP runtime work with the approval broker.

## Exact remote-service decision (still open)

The requested pinned image exists and installs spacesd v0.1.0 (provenance above).
No FSL implementation or generated bindings are copied/distributed by this PR.
Running that bundled service is a separate use of a non-MIT component; this PR
has not made a legal/organizational eligibility decision or launched it. To finish
actual CUA endpoint acceptance, the owner can either authorize this exact pinned
spacesd-containing image for isolated internal CI under its applicable terms, or
supply an already-approved endpoint/artifact of the requested protocol. A newer
MIT local-driver MCP endpoint is not silently interchangeable with this gRPC-Web
service. Meanwhile, all codec/model-loop tests remain clearly marked fixtures.
