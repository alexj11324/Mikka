# Proposed Skill source boundary for #232 / #237

Status: **coordination proposal only**. #232 currently has an issue, not an
implemented trusted registry/assignment receipt path. #238 does not consume
this proposed type and must continue to record `skillUsage: "unrecorded"`.
Shape validation, feedback, a worker report or a content hash alone cannot
establish that a run actually received or executed a particular Skill.

The subsequent [minimal builtin assignment wiring](self-improvement-assignment-wiring.md)
implements a narrow first source on a separate branch. It does not implement
the complete #232 registry or prove candidate Harness regression/activation.

## Minimal reference

The #232 owner should mint an immutable reference after its existing source,
review, manifest and content checks. This reference identifies bytes; it does
not grant permission to install, execute, publish or retain them.

```ts
type SkillArtifactRef = {
  schemaVersion: 1
  registryId: string       // server-resolved, tenant-scoped registry identity
  skillId: string          // UUID; existing Skill identity
  versionId: string        // UUID; immutable #232 version identity
  sha256: string           // 64 lowercase hex; exact immutable artifact bytes
}
```

The #232 owner defines the immutable artifact serialization before computing
`sha256`, and supplies its existing source/license/review/permission-manifest
record through `versionId`. Do not silently substitute a live filesystem path,
mutable branch, display name, URL or `id/name` run ref. Do not use #238's
canonical-JSON configuration `digest()` as a raw-byte artifact SHA256. This
proposal does not introduce a package/archive format, registry table or network
fetcher.

## Trusted assignment receipt

A reference becomes evidence of assignment only through a server-owned receipt
persisted with the actual claim/assignment. Proposed minimal envelope:

```ts
type SkillAssignmentReceipt = {
  id: string              // server-generated immutable UUID
  runId: string
  sessionId: string
  issueId: string
  userId: string          // server-derived owner, never accepted from feedback
  deviceRepoId: string
  artifacts: SkillArtifactRef[]
  assignedAt: string      // server timestamp
}
```

The receipt is a pointer to actual authorized assignment, not an authorization
token. #232 must verify current tenant access, review/withdrawal status and any
existing policy/approval requirements at claim/mount/resume. Its trusted daemon
consumer verifies the installed bytes against the receipt. Persisting a worker's
claimed digest by itself does not prove actual mounting or usage. Independent
execution evidence remains #193's responsibility.

Receipt issuance must follow the existing run/attempt/lease fences and must not
survive an unrelated run/session or changed source binding. A retry/resume must
revalidate current authorization and withdrawal state. #230 owns effective
policy propagation; this proposal does not define a parallel policy hash or
override. Permission expansion still requires the existing approval path.

## Current inputs and future consumer boundary

| Input | What #238 currently validates | What it cannot prove |
| --- | --- | --- |
| Browser request | Existing authenticated session, exact-origin POST, 16 KiB streaming limit | Skill source or assignment |
| `feedback` | Strict action/event/run/verdict/note shape; bounded untrusted note | Truth, permission, Skill version or candidate eligibility |
| `propose` | Strict action/run shape; no caller scorer, threshold, owner, target or content | Installation, activation or deployment approval |
| Existing run | Owned finished run/session/repository, current issue access, cancellation checks | Historical Skill bytes; worker report is an assertion |
| Score | Immutable scorer definition/version and input snapshot/digest | Independent verification or missing historical provenance |
| Offline candidate | One inactive allowlisted document; fixed cases/evaluator | #232 registry acceptance or actual Harness improvement |

No current API accepts a `SkillArtifactRef`, receipt, path, registry URL or
caller-supplied digest. Once #232 implements receipts, #237 should accept at
most an existing receipt identifier through a coordinated trusted adapter and
resolve it server-side, rechecking its original owner/issue/run/session and
artifact bindings. A client-supplied object that merely parses must remain
untrusted and must never be promoted to a trusted receipt.

Scoring snapshots may then pin the resolved immutable reference and receipt ID.
Failure aggregation must partition by the actual assigned Skill version/digest;
never backfill old runs with the current active version. Baseline/candidate
comparison must keep the independent benchmark version fixed. Missing receipts
stay `unrecorded` and cannot establish a production improvement claim.

After a real candidate commit, #192 retains stage/SHA ownership, #193 provides
independent review/verification, #194 provides human action/target approval,
#232 owns activation/withdrawal, #208 owns external side effects and #195 owns
monitoring/recovery. This document changes none of those implementations.

## Needed from #232 before integration

Confirm registry/version identity and raw-byte serialization, receipt issuance
at the existing claim boundary, immutable receipt read/access checks, actual
mount evidence and withdrawal behavior for new runs/resume/children. Until
that path exists and passes actual system tests, integration remains pending.
