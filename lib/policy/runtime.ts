import "server-only";
import { transaction } from "../audit/store";
import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "@/lib/db";
import { workspacePool } from "@/lib/workspace-db";
import { policySigner } from "./signing";
import { PolicyStore } from "./store";
import { authorizeModelRequest } from "./model";
import type { PolicyClient } from "./sql-client";
import { workerPolicyScope } from "./run-scope";
import { PolicyError, type ModelRoute } from "./contract";

export function policyStore() {
  return new PolicyStore(
    workspacePool,
    policySigner(process.env.BETTER_AUTH_SECRET ?? ""),
  );
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
  const scope = await workerPolicyScope(pool, userId, runId, workspaceId);
  if (!scope.verified) await policyStore().denyWorker(userId, runId);
  workspaceId = scope.workspaceId;
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
  suppliedWorkspace?: string,
) {
  const scope = await workerPolicyScope(app, userId, runId, suppliedWorkspace);
  if (!scope.verified) {
    const denied = await policyStore().workerDenial(workspace, userId, runId);
    if (denied) return denied;
  }
  const workspaceId = scope.workspaceId;
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

/** Claim hooks already hold the app transaction. Never borrow another app
 * connection; workspace denial audits commit independently before app rollback. */
export async function authorizeWorkerClaim(
  app: PolicyClient,
  userId: string,
  runId: string,
  issueId: string,
  workspaceId?: string,
) {
  try {
    const denied = await transaction(workspacePool, (tx) =>
      workerPolicyInTransaction(app, tx, userId, runId, issueId, workspaceId),
    );
    if (denied) throw denied;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError("policyUnavailable", 503);
  }
}
