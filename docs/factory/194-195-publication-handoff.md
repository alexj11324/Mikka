# #194 → #195 publication receipt v1

Read against #195 PR200 `994ae2e5ec781a21063128394f258bcc8ee38473`. No #195 files or branch are modified here. Its existing `monitorGate` checks prior stage passes, evidence, independent run/session identities and publish timing, but does not yet read #194's actual action/target/provider receipt. A passed publish attempt alone therefore cannot establish which running target was checked. The parent must coordinate the following call and target/probe binding before actual recovery acceptance.

## Frozen additive reader

`readFactoryPublicationReceipt(tx, userId, taskId, candidateId)` in `lib/factory/publication-receipt.ts` is a trusted backend-only read inside the existing authorized/locked Factory transaction. It returns this exact envelope or fails closed:

```ts
{
  version: 1,
  publicationId: UUID, approvalId: UUID,
  taskId: UUID, issueId: UUID, candidateId: UUID,
  candidate: { sha, repository, environment, scope },
  action: "deploy_preview" | "deploy_production" | "merge",
  target: string, // exact human-approved registered target identifier
  targetEnvironment: string, // separately human-approved destination; candidate.environment may be device:<UUID>
  publishedAt: ISODateTime, // persisted passed publish-attempt finish
  reference: string,
  verifiedTarget: {
    kind: "local-artifact" | "preview-deployment" | "merge",
    operationId: string,
    target: string, environment: string, repository: string, sha: string,
    reference: string,
    observedAt: ISODateTime
  }
}
```

`action/target` are authoritative `factory_publications` columns, bound to the human approval. They were not fields inside the original `{reference}` receipt. New concrete adapters must return `verifiedTarget` after actual target readback. The publication service and gate check that its target/repository/SHA/reference match the fixed candidate and configured action/target, and its actual environment matches the separately approved targetEnvironment. Bare request IDs or reference-only receipts cannot pass the new receipt schema. The helper also requires a succeeded publication, the exact passed publish attempt/output IDs, matching immutable candidate identity, current task ownership/candidate and no approval/task revocation. It intentionally does not reject a legitimately consumed historical publication merely because the approval's expiry later passed.

`local-artifact` receipts use the actual reservation UUID, persisted file contents and SHA256 readback and can only represent a local environment. `preview-deployment` references must be HTTPS without credentials/query/fragment, and the trusted provider adapter must verify the operation's immutable deployment identity and exact SHA before returning. No external Preview adapter is installed or called yet. Production execution is prohibited by the service. `merge` is a repository action and is never proof of a deployed environment.

## #195 binding and actual probe rules

Inside its existing gate, #195 should call this reader after its current owner/fence checks and before accepting recovery. It must fail closed if the reader fails. Its probe evidence must then bind:

```ts
// Proposed audit payload in existing free-form finish.output; parent coordinates
// field names with #195. This is not a claim that PR200 already emits it.
monitorAudit: {
  version: 1,
  publicationId, approvalId,
  candidateId, sha, repository, environment, scope,
  action, target, targetEnvironment,
  operationId, checkedReference,
  requestId, runId, sessionId,
  startedAt, finishedAt,
  command, exitCode, timedOut,
  observedSha, observedTarget,
  logArtifacts: [`run-chunk:${UUID}`]
}
```

- All candidate/action/target/targetEnvironment/operation/reference fields must equal the receipt; no alias, another Preview or production origin substitution. `startedAt >= publishedAt` and `finishedAt >= startedAt`; only checking the monitor run's end time is insufficient.
- The probe must be performed by the independent bound monitor run/session and produce actual same-run raw artifacts. Successful executor/daemon self-report or a passed verify command without target evidence cannot prove recovery.
- `preview-deployment`: check the immutable Preview reference, correlate its actual provider deployment SHA/operation/environment and the health response. Use the existing authorized read client; do not expose credentials. A wrong/unknown observed SHA or target is blocked/failed.
- `local-artifact`: permit only expressly configured local readback acceptance. It cannot mark a cloud incident recovered. The local receipt and scope/environment must remain local.
- `merge`, absent/unverified receipt, wrong action, uncertain/reserved publication or missing target-specific observation: do not mark environment recovery. Preserve failure/blocked evidence and the existing repair path.
- Retain #195's existing four-way execution/review/verification/monitor identity separation, cancellation and owner/workspace fences. This helper does not replace its gate, fingerprint or evidence ledger.

Do not reuse candidate.environment as the deployment environment: #193 fixes it to device:<UUID>. Keep that provenance, and isolate actual target observations/incidents by targetEnvironment and the qualified target identifier; PR200 currently fingerprints the candidate environment and needs parent-coordinated target isolation before real deployment recovery.

The local PG acceptance now reads this envelope from an actual #194 publication and asserts the exact action/target/candidate/environment; foreign-owner lookup fails. Provider-level probe compatibility remains pending parent coordination and the denied Preview authorization. No actual-target compatibility is claimed from the local artifact case.
