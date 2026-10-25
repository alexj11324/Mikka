import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { workspacePool } from "@/lib/workspace-db";
import { appOrigin } from "@/lib/mcp/resource";
import { policySigner } from "./signing";
import { PolicyStore } from "./store";
import { policyHttp } from "./http";
import { authorizeModelRequest } from "./model";
import type { PolicyClient } from "./sql-client";
import { PolicyError, type ModelRoute } from "./contract";

export function policyStore() {
  return new PolicyStore(
    workspacePool,
    policySigner(process.env.BETTER_AUTH_SECRET ?? ""),
  );
}
export async function handlePolicy(request: Request) {
  try {
    return await policyHttp({
      store: policyStore(),
      origin: appOrigin ?? "",
      authenticate: async (req) => {
        const session = await auth.api.getSession({
          headers: req.headers,
          query: { disableCookieCache: true },
        });
        return session ? { userId: session.user.id } : null;
      },
    })(request);
  } catch {
    return Response.json(
      { error: "policyUnavailable" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
export async function authorizeModel(userId: string, route: ModelRoute) {
  return authorizeModelRequest(policyStore(), userId, route);
}
export async function authorizePolicyWorker(
  userId: string,
  runId: string,
  issueId?: string,
  workspaceId?: string,
) {
  // #210 captures the original tenant across retry and later task moves.
  const captured = (
    await pool.query(
      "SELECT tenant FROM security_audit_resource_scopes WHERE source='agent_runs' AND resource=$1 AND owner_id=$2",
      [runId, userId],
    )
  ).rows[0];
  if (captured?.tenant && !captured.tenant.startsWith("personal:")) {
    if (workspaceId && workspaceId !== captured.tenant)
      throw new PolicyError("policyScopeMismatch", 403);
    workspaceId = captured.tenant;
  }
  return policyStore().denyWorker(userId, runId, issueId, workspaceId);
}
/** Existing tool/native transports cannot attest to all model/network child calls. */
export async function authorizePolicyTool(
  userId: string,
  workspaceId?: string,
) {
  return policyStore().denyTool(userId, workspaceId);
}

/** Called inside the existing MCP transaction scopes: uses exactly their two
 * connections and commits a policy denial before returning it to the caller. */
export async function workerPolicyInTransaction(
  app: PolicyClient,
  workspace: PolicyClient,
  userId: string,
  runId: string,
  issueId: string,
) {
  const captured = (
    await app.query(
      "SELECT tenant FROM security_audit_resource_scopes WHERE source='agent_runs' AND resource=$1 AND owner_id=$2",
      [runId, userId],
    )
  ).rows[0];
  const workspaceId =
    captured?.tenant && !captured.tenant.startsWith("personal:")
      ? captured.tenant
      : undefined;
  return policyStore().workerDenial(
    workspace,
    userId,
    runId,
    issueId,
    workspaceId,
  );
}

const toolAdmission = new AsyncLocalStorage<string>();
/** Nested integration calls reuse the outer admission and its held locks. */
export async function withPolicyTool<T>(
  userId: string,
  work: () => Promise<T>,
  capturedWorkspaces: string[] = [],
): Promise<T> {
  if (toolAdmission.getStore() === userId) return work();
  return policyStore().withTool(
    userId,
    () => toolAdmission.run(userId, work),
    capturedWorkspaces,
  );
}
