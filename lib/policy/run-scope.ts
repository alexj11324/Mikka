import { PolicyError } from "./contract";
import type { PolicyClient } from "./sql-client";

/** Audit projection is evidence, not a universal authorization source. Legacy
 * personal/missing parent captures cannot attest to an original organization. */
export async function workerPolicyScope(
  app: PolicyClient,
  userId: string,
  runId: string,
  suppliedWorkspace?: string,
) {
  const pending = [{ id: runId, ancestors: new Set<string>() }],
    seen = new Set<string>();
  let workspace: string | undefined,
    issue: string | null | undefined,
    resumed = false;
  const captures: (string | undefined)[] = [];
  while (pending.length) {
    const { id, ancestors } = pending.pop()!;
    if (ancestors.has(id)) throw new PolicyError("policyScopeUnverified", 403);
    if (seen.has(id)) continue;
    if (seen.size >= 32) throw new PolicyError("policyScopeUnverified", 403);
    seen.add(id);
    const row = (
      await app.query(
        `SELECT r."userId",r."issueId",r."retryOf",r."continuesRunId",r."questionContinuation",s.tenant,s.owner_id
      FROM agent_runs r LEFT JOIN security_audit_resource_scopes s ON s.source='agent_runs' AND s.resource=r.id::text WHERE r.id::text=$1`,
        [id],
      )
    ).rows[0];
    if (
      !row ||
      !row.tenant ||
      row.userId !== userId ||
      (issue !== undefined && row.issueId !== issue)
    )
      throw new PolicyError("policyScopeUnverified", 403);
    issue = row.issueId;
    if (row.tenant && row.owner_id !== userId)
      throw new PolicyError("policyScopeUnverified", 403);
    const tenant =
      row.tenant && !row.tenant.startsWith("personal:")
        ? (row.tenant as string)
        : undefined;
    captures.push(tenant);
    if (tenant) {
      if (workspace && workspace !== tenant)
        throw new PolicyError("policyScopeMismatch", 403);
      workspace = tenant;
    }
    const question = row.questionContinuation;
    if (
      question != null &&
      (typeof question !== "object" ||
        typeof question.originRunId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          question.originRunId,
        ))
    )
      throw new PolicyError("policyScopeUnverified", 403);
    for (const parent of [
      row.retryOf,
      row.continuesRunId,
      question?.originRunId,
    ]) {
      if (!parent) continue;
      resumed = true;
      if (parent === id || parent === runId)
        throw new PolicyError("policyScopeUnverified", 403);
      pending.push({ id: parent, ancestors: new Set([...ancestors, id]) });
    }
  }
  if (resumed && captures.some((tenant) => !tenant))
    throw new PolicyError("policyScopeUnverified", 403);
  if (suppliedWorkspace && workspace && suppliedWorkspace !== workspace)
    throw new PolicyError("policyScopeMismatch", 403);
  return {
    workspaceId: workspace ?? suppliedWorkspace,
    verified: Boolean(workspace),
  };
}
