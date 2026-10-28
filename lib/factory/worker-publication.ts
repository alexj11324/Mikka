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
  return { ...runtime, actor: { userId: identity.userId } };
}
