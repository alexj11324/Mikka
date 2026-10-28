# Controlled improvement assignment and Factory wiring

- Status: implementation candidate; actual CLI/production acceptance pending.
- Migration names below describe the original checkpoint. The 2026-10-28
  compatibility update preserves SQL and historical ledger IDs; see
  [migration compatibility](../factory/migration-compatibility-20261028.md).
- Tracking: #237 / MIK-103; minimal prerequisite of #232, not its enterprise registry.
- Frozen baseline: #238 `62a6f710f454aa0860e09a5a941f2720657c96ef`.
- Follow-up branch: `codex/skill-assignment-factory-237-20261025`.
- Factory dependency: parent-published #243 `d40d9d848659aa1efb5f2af0f18c39eb93826289`,
  containing #239 `8ed6fea9c4ac446a0099a0334ca43a9cf85c0a28` and main
  `40cbaff439dae444dd3f97729a7df450d7ec7b58`. That composition was merged unchanged;
  this follow-up did not independently resolve or rewrite the Factory integration.

## Implemented boundary

Additive migration: `20261025083303_improvement_skill_assignments.sql`; no existing
migration file is renamed or edited. The tables store builtin versions,
selections, claim receipts and links to the existing Factory task/attempt/run.

One application-owned baseline Skill is available for an explicitly requested
rehearsal. Its immutable version contains the exact `skillMarkdown` UTF-8 bytes,
including frontmatter, and a raw-byte SHA256. No marketplace, upload, arbitrary
URL, permission manifest override, candidate installation or new credential is
introduced. Updating these builtin bytes requires a new code-reviewed version.

The source ref is `{schemaVersion:1, registryId:"mikka-builtin", skillId, versionId,
format:"single-skill-md-v1", sha256}`. The server persists a selection for an
existing authorized queued run. `rehearse` commits normal Factory dispatch and
that selection in the same transaction, before a worker can claim the run.

Only the actual claim route records the immutable receipt after its real claim
CAS and before returning the assignment. It rechecks current owner, issue,
agent/device/repository, stop state, lease and the supported-worker marker.
The returned assignment carries the exact baseline Skill and receipt. A failure
to record provenance returns no assignment bytes and fails the claimed run.
A crash before receipt recording yields no receipt; a lost response after its
commit may leave a receipt for bytes the worker never received. Therefore its
meaning is **server prepared assignment**, never delivered/mounted/executed.
Selections by themselves do not produce provenance. Historical runs stay
`unrecorded`; a model/worker report cannot supply a trusted receipt.

The updated daemon verifies run/device/repository/lease bindings and the Skill
bytes before starting an adapter. The existing CC, Codex and Cursor adapters
pass the receipt into their real `RunContext`. That code verifies the actual
written `SKILL.md` bytes. For receipted artifacts, existing symlinks, nonfiles
and multiple-link files are rejected; an existing pinned file is read/verified,
never truncated, and a new file is created exclusively. This does not claim
general protection against arbitrary same-UID concurrent process tampering.

## Restart, retries and current access

Receipted runs never extend a stale local lease on restart. Before adapter
resume, the new daemon calls the authenticated server receipt-validation route;
the server rechecks the actual receipt, current issue access, enabled device,
source binding, current builtin allowlist, live run/stop state and unexpired
server lease. Missing support, network failure, expiry, revocation or drift
leaves the local run blocked. The existing sync loop retries only those Skill
resumes blocked before launch; it does not add a recovery scheduler or retry
legacy runs. Interrupted `finishing` stays blocked for explicit reconciliation
and cannot automatically replay an uncertain publication.

Heartbeats for receipted runs recheck the same source/access/capability boundary;
the check and lease update share the same transaction and locked run, with a
stop/lease CAS. Rejected runs are returned in `revoked` and receive no renewed lease. Existing
nonreceipted lease behavior is unchanged. A device capability header is a
compatibility marker, **not** a cryptographic binary attestation. The server
cannot prevent an arbitrary old binary from executing its cached journal while
fully offline; complete downgrade/worker attestation is still #214/#230 scope.
No claim of full #232 withdrawal/offline/children guarantees is made here.

An automatic lease retry with a selected ancestor but no current selection is
rejected at claim. It needs an explicit current authorized baseline selection;
we neither fabricate an ancestor receipt for the new run nor silently drop its
selected Skill. No retry count, centralized policy, permission or budget changes.

## Existing chat, HTTP and Factory interfaces

`/api/self-improvement` retains session identity, strict action schemas, exact
origin and the 16 KiB streaming limit. Additions are:

| Action | Input | Effect |
| --- | --- | --- |
| `select_baseline` | `runId` | Explicit baseline selection for a queued run |
| `rehearse` | existing Factory `binding`, agent/repository IDs | Atomic existing dispatch + baseline selection |
| `handoff` | `proposalId`, existing execute `binding`, agent/repository IDs | Atomic proposal link + existing Factory dispatch |
| GET by `proposalId` | owned proposal ID | Reads linked existing Factory state; no gate mutation |

No action accepts source refs, arbitrary bytes, receipt objects, scorer changes,
thresholds, permission grants, approval data or publication commands.
`GET /v1/runs/:runId/skill-receipt?receiptId=...` uses existing device authentication
and reads current resume eligibility; the supplied ID is resolved server-side.

Coordinator durable steps/tools call these exact services: baseline rehearsal,
explicit selection, feedback, proposal/read and Factory handoff/status. They
do not pass a stage or act as a human approver. Existing wakes/reconciliation
and Harness assignment/mount paths are reused.

Handoff validates **every** immutable proposal source against its real run and
receipt, current repository and stop state. A missing source is rejected rather
than silently validating survivors. Legacy/unrecorded proposals remain offline.
The same transaction calls the existing Factory dispatcher with the frozen
inactive document diff; duplicate requests return one logical linked run and
changed bindings conflict. The parent-composed actual #193 review/verification
and #194 human approval/publish gates remain the only gate implementations.
There is no new activation or publication adapter.

## Candidate/evaluation truth

The proposal still changes the **inactive document** only. Its old
`baselineDigest`/`candidateDigest` use the established canonical-JSON string
digest, while the assigned artifact's `sha256` hashes `skillMarkdown` bytes.
Those schemes and artifacts must not be equated. The builtin's instructions
still come from the frozen `BASELINE` constant. Consequently this handoff does
not prove a candidate assigned artifact was run through a real Harness, nor
that model quality improved. Fixed synthetic document comparison remains
`independentVerification=false`, `productionEligible=false`; no evaluation
threshold was changed and no candidate is automatically adopted.

## Validation and exact runtime prerequisites

Local source/real PG17/HTTP checks use a dedicated loopback synthetic database,
actual immutable ledgers, actual #191 queue transactions, actual Factory
dispatcher/store/gates and actual filesystem `RunContext` mounting. They cover
ten-way replay, 25 assigned failures, missing sources, old-worker rejection,
current stop/access and receipt checks, retry-source loss, no offline adapter
launch, cancellation while online resume authorization is pending, concurrent
heartbeat/stop fences, symlink/hardlink preservation and no model-supplied provenance. They
do not invoke a paid model, a real CLI or a publication adapter.

The added remote browser-CI test uses built **actual Next routes**, synthetic
cookie/device identities, actual claim/receipt/resume/heartbeat HTTP and actual
mounted-byte readback. Its terminal report/session fixture is expressly
synthetic and does not call completion/wake a paid Coordinator. Existing
#193/#194 tests and validators are reused, not replaced with permissive mocks.

Real Harness acceptance still needs the parent to provide a fixed authorized
deployment/database with both migrations, a device running this exact updated
daemon, current authorized repository and verify command, and an existing
permitted CLI session/model budget. Then exercise actual chat→rehearsal→claim→
mount→real session/tool output→feedback, collect enough real qualifying failures
without changing the fixed trigger, produce an actual candidate commit, and
run fresh independent #193 checks and real human #194 approval. Candidate
artifact evaluation/activation needs its separately reviewed immutable source
version and explicit scope, not the synthetic inactive-document score.

The parent owns #243 integration, approved fixed-version production deployment,
real user readback, monitoring/recovery and the sanitized playable PR acceptance
video. New IAM/credentials, paid calls beyond authorized budgets, data deletion
and irreversible actions still require their specific authorization. This
candidate does not claim any of those runtime gates passed.
