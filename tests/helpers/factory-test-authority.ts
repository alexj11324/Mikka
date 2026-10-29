import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { approvalRequest, FactoryError } from '../../lib/factory/approval-contract'
import { createFactoryApprovalGates, createFactoryApprovals, type PublicationAdapter } from '../../lib/factory/approval'
import type { FactoryApprovalStore, FactoryAuthorize } from '../../lib/factory/approval-dependencies'
import { factoryCheckIndependent } from '../../lib/factory/check-independence'
import { digest } from '../../lib/factory/evidence'
import type { FactoryDecisionAuthority, FactoryDecisionScope, FactoryVerifiedPolicyDecision } from '../../lib/factory/policy-authorization'

/** Explicit lifecycle for DB fixtures. This still uses the real ancestry check;
 * it grants no review/verify/publication consumer gate by itself. */
export const factoryTestLifecycle = { independent: factoryCheckIndependent }

/** Synthetic policy/vision receipts for contract tests only. No real authority,
 * model judgment, Harness acceptance or publication authorization is claimed.
 * A credential is frozen to the request at issuance; verification never adopts
 * a changed target, candidate, evidence set or owner from the caller. */
export function createFactoryTestAuthority() {
  const decisions = new Map<string, { scope: FactoryDecisionScope; decision: FactoryVerifiedPolicyDecision }>()
  const authority: FactoryDecisionAuthority = {
    async verify(_tx, credentialId, expected) {
      const fixture = decisions.get(credentialId)
      if (!fixture) throw new FactoryError('factoryPolicyDecisionUnavailable')
      if (digest(fixture.scope) !== digest(expected)) throw new FactoryError('factoryPolicyDecisionMismatch')
      return structuredClone(fixture.decision)
    },
  }
  return {
    authority,
    gates: createFactoryApprovalGates(authority),
    approvals(pool: Pool, authorize: FactoryAuthorize, store: FactoryApprovalStore, adapters: PublicationAdapter[] = []) {
      return createFactoryApprovals(pool, authorize, store, adapters, authority)
    },
    request(ownerId: string, input: unknown, evidence: { manifest: { artifacts: { kind: string; sha256: string }[] } }) {
      const request = approvalRequest.parse(input)
      const credentialId = `synthetic-factory-policy:${randomUUID()}`
      const scope: FactoryDecisionScope = {
        ownerId,
        binding: request.binding,
        candidate: request.candidate,
        action: request.action,
        target: request.target,
        targetEnvironment: request.targetEnvironment,
        evidenceDigest: request.evidenceDigest,
        expiresAt: request.expiresAt,
        visualEvidenceDigests: evidence.manifest.artifacts
          .filter(artifact => artifact.kind === 'screenshot' || artifact.kind === 'video')
          .map(artifact => artifact.sha256),
      }
      const scopeDigest = digest(scope)
      const decision: FactoryVerifiedPolicyDecision = {
        version: 1,
        credentialId,
        issuer: 'synthetic-contract-fixture',
        policyId: 'synthetic-contract-policy',
        policyRevision: '1',
        permissionAction: scope.action,
        ownerId,
        scopeDigest,
        decision: 'allow',
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: request.expiresAt,
        verification: { receiptId: `synthetic-receipt:${credentialId}`, signatureDigest: digest(['fixture', scope]) },
        judgment: {
          receiptId: `synthetic-judgment:${credentialId}`,
          model: 'fixture-no-model-invocation',
          capability: 'vision',
          visualInputRequired: scope.visualEvidenceDigests.length > 0,
          scopeDigest,
          evidenceDigest: scope.evidenceDigest,
          imageDigests: scope.visualEvidenceDigests,
        },
      }
      decisions.set(credentialId, structuredClone({ scope, decision }))
      return { ...request, decisionCredentialId: credentialId }
    },
  }
}
