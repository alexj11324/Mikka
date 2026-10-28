import "server-only";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { verifyRunToken, workerRun } from "@/lib/mcp/worker";
import { FactoryError } from "./approval-contract";
import type {
  FactoryApprovalStore,
  FactoryAuthorize,
} from "./approval-dependencies";
import type {
  createFactoryApprovalGates,
  PublicationAdapter,
} from "./approval";
import {
  createFactoryPublicationHost,
  lockFactoryPublicationExecutor,
  type FactoryPublicationHost,
} from "./run-decision-authority";
import {
  createFactoryRunReviewIssuer,
  type FactoryRunReviewSigner,
} from "./run-review-issuer";
import {
  invokeFactoryPublicationDecision,
  type FactoryPublicationDecisionTransport,
} from "./publication-invocation";
import {
  factoryDecisionScope,
  type FactoryDecisionScope,
} from "./policy-authorization";

/** Backend call point only; not a route/tool registration or permission grant.
 * Reuse the real worker-token authentication, derive owner/run/Bot on the server,
 * then recheck the token/run/lease/current registered policy in the operation TX.
 * Client/model JSON cannot supply this host identity or the policy/key callbacks.
 * No production signer/keys/policy source is configured by importing this file. */
export async function factoryPublicationForWorker<
  S extends FactoryApprovalStore,
>(
  request: Request,
  deps: {
    pool: Pool;
    authorize: FactoryAuthorize;
    createStore(
      gates: ReturnType<typeof createFactoryApprovalGates>,
      identity: ReturnType<typeof workerRun>,
    ): S;
    host: Omit<
      FactoryPublicationHost,
      "ownerId" | "executionRunId" | "tokenHash"
    >;
    adapters?: PublicationAdapter[];
    /** Optional trusted SERVER dependency; never supplied by request/model JSON.
     * Absent until an existing signing identity/policy binding is authorized. */
    reviewSigner?: FactoryRunReviewSigner;
    /** Actual shared #193 serializer/invoker, installed by trusted host code. */
    reviewTransport?: FactoryPublicationDecisionTransport;
  },
) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer "))
    throw new FactoryError("factoryPolicyPrincipalUnavailable");
  const token = authorization.slice(7).trim();
  const auth = await verifyRunToken(request, token);
  if (!auth) throw new FactoryError("factoryPolicyPrincipalUnavailable");
  const identity = workerRun(auth);
  const principal = {
    ownerId: identity.userId,
    executionRunId: identity.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  };
  const authorize: FactoryAuthorize = async (userId, issueId, tx) => {
    if (
      userId !== identity.userId ||
      issueId !== identity.issueId ||
      !(await deps.authorize(userId, issueId, tx))
    )
      return false;
    await lockFactoryPublicationExecutor(tx, principal, issueId);
    return true;
  };
  const runtime = createFactoryPublicationHost(
    deps.pool,
    authorize,
    (gates) => deps.createStore(gates, identity),
    {
      ...deps.host,
      ...principal,
    },
    deps.adapters,
  );
  const reviewIssuer = deps.reviewSigner
    ? createFactoryRunReviewIssuer(
        runtime.store,
        {
          ...deps.host,
          ...principal,
        },
        deps.reviewSigner,
      )
    : undefined;
  async function review(scopeInput: FactoryDecisionScope) {
    // Parse clones nested fields before the first await. The caller retains no
    // reference that can swap scope between prepare/invoke/issue.
    const scope = factoryDecisionScope.parse(scopeInput);
    const transport = deps.reviewTransport;
    if (
      !reviewIssuer ||
      !transport ||
      transport.modelId !== deps.host.decisionModelId
    )
      throw new FactoryError("factoryPolicyModelEvidenceUnavailable");
    const prepareTx = await deps.pool.connect();
    const prepared = await (async () => {
      try {
        await prepareTx.query("BEGIN");
        const result = await reviewIssuer.prepare(prepareTx, scope);
        await prepareTx.query("COMMIT");
        return result;
      } catch (error) {
        await prepareTx.query("ROLLBACK");
        throw error;
      } finally {
        prepareTx.release();
      }
    })();
    const invocation = await invokeFactoryPublicationDecision(
      scope,
      prepared.executor,
      prepared.observations,
      transport,
    );
    if (!invocation)
      throw new FactoryError("factoryPolicyModelEvidenceUnavailable");
    const issueTx = await deps.pool.connect();
    try {
      await issueTx.query("BEGIN");
      const chunk = await reviewIssuer.issue(issueTx, scope, invocation);
      await issueTx.query("COMMIT");
      // The existing authenticated run-event writer owns append/sequence.
      // Returning this chunk does not persist it or authorize an operation.
      return chunk;
    } catch (error) {
      await issueTx.query("ROLLBACK");
      throw error;
    } finally {
      issueTx.release();
    }
  }
  return {
    ...runtime,
    actor: { userId: identity.userId },
    ...(reviewIssuer ? { reviewIssuer, review } : {}),
  };
}
