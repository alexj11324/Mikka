# Exact #193 → #194 evidence handoff

Verified by reading frozen PR199 `05f9dbb3e357268df73ea863f7ebac3edfb5967b`, including `checks.ts`, `reconcile-check.ts` and `server.ts`. No #193 files/validators or #192 contract fields are modified by #194. This is source/schema compatibility plus local layer verification, not a claim of real CC/Codex acceptance.

## Same-store composition

Compose the existing gates on one store, and pass that identical store to the approval service:

```ts
const store = createFactoryStore(pool, authorizeFactoryIssue, {
  ...factoryCheckGates, // #193 review/verify
  approval: approvalGate, publish: publishGate, // #194
  monitor: monitorGate, // #195 when integrated
});
const approvals = createFactoryApprovals(pool, authorizeFactoryIssue, store,
  configuredLocalPublicationAdapters(process.env));
```

Keep #193's dispatch/claim/reconciliation imports and #191's existing transaction integration. Resolve the overlapping `server.ts` composition in the parent; do not create another store or authorize cache.

## Current required persisted state

For one exact candidate UUID and `sha/repository/environment/scope`, the latest `execute`, `review` and `verify` attempts must all have `status='passed'`, each with a distinct persisted `runId` and `sessionId`. A failed latest retry cannot be hidden by an earlier pass. Existing `apply` transitions must place the task at pending approval.

Each referenced `agent_runs` row must have the exact task owner/issue and attempt session, `status='succeeded'`, `stopRequestedAt=null`, and actual persisted start/finish timestamps. Execute must additionally have `stopReason='submitted'`, `report.publish.commit===candidate.sha` and `report.verify.status==='passed'`.

#193 already persists these concrete report fields, and its trusted check gate validates them:

```ts
report.check = { sha: exactCandidateSha, readOnly: true };
report.verify = {
  status: "passed", command: frozenVerifyCommand,
  exitCode: 0, signal: null, timedOut: false, output: actualOutputTail
};
report.filesChanged = [];
report.criteria = [{ passed: true, evidence: concreteCriterionEvidence, ... }];
```

The existing attempt output retains the frozen assignment and completion:

```ts
output = {
  check: { stage, candidateId, sha, repository, environment, command, deviceRepoId },
  completion: {
    runId, stopReason, error, verify, check, summary, findings, knownIssues
  }
};
```

#194 does not require a new `verificationAudit` wrapper. It reads the actual report JSON and chunk rows unchanged; extra #193 report fields are retained in raw artifact readback and its source hash. #193 remains responsible for accepting these facts only from the existing trusted Harness/process/report path, with read-only assignment, immutable checkout, real independent sessions and actual verifier command evidence. A model assertion or a worker-written `exitCode:0` is not authority.

## Exact artifact references

```ts
// factory_attempts.evidence[] / finish.evidence[]: frozen #192 schema
{
  artifact: `run-report:${runId}`, // or `run-chunk:${chunkRowId}`
  kind: "report",                 // or "log" for run-chunk
  runId, sessionId,
  candidateId: exactCandidateId, sha: exact40CharacterSha,
  environment: exactCandidateEnvironment,
  recordedAt: actualISOTimeAfterSourceWasPersisted
}
```

The report must exist on the same run. Every chunk row must exist and have that same `runId`. #193's verifier evidence already includes matching `tool-input-available` Bash/shell chunks and their paired `tool-output-available`/`tool-output-error` chunks, correlated by `toolCallId` and sequence. #194 accepts those exact chunk IDs as log artifacts. It does not reconstruct or paraphrase their output. Raw source can be read through the authenticated artifact endpoint, with credential redaction; source retention must remain intact.

#193 records `recordedAt` from the persisted run finish. The report source timestamp is that finish; chunk source timestamps are their actual `createdAt`. #194 requires `recordedAt >= source timestamp`, hashes original JSON, and stores run start/finish/source timestamps. These timestamps represent run lifecycle and persisted event observations; do not relabel them as exact OS process start/end times. If chunks arrive after the recorded run finish, the consumer rejects rather than inventing an earlier observation; reconciliation must then use a truthful later recorded timestamp. Source mutations/deletions, wrong owner/session/candidate/environment or changed digest invalidate approval.

## Execution environment versus publication environment

#193's assignment requires `candidate.environment === "device:<device UUID>"` and candidate repository equal to the actual device repository remote/path. That is execution/check provenance. #194 preserves it without reminting the candidate.

Publication destination is separately human-bound as required `targetEnvironment` in both approve and publish requests. It is persisted in existing request JSON. Publication requires exact equality across the approved destination, registered adapter environment and verified target receipt. The candidate's device environment remains unchanged. The concrete local adapter takes separate `candidateEnvironment` and local destination `environment`; local PG tests cover this distinction and reject substitution. A future Preview adapter likewise accepts the frozen device candidate and verifies its approved actual Preview environment.

## Remaining real acceptance

The parent must still combine the exact #193 and #194 code, run actual CC/Codex execution/review/verification, and preserve its real report/chunk/request/session evidence. Local fixtures prove field and transaction behavior only. A real human must sign in through existing Google/GitHub OAuth, read that frozen evidence, and approve exact candidate/action/target/targetEnvironment/expiry. A permitted nonproduction target and #181 same-version acceptance are still required.

Screenshots/video must come from Claude's fixed real Preview and need a trusted access-controlled source reader/hash/run/session/time. Current #194 rejects arbitrary URLs and unsupported image/video stores. Backend local checks use real HTTP/PG/process/readback logs; no captures are fabricated.
