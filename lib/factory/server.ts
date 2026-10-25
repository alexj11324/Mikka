import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@/lib/db";
import { issueForUser } from "@/lib/issue-access";
import { createFactoryStore } from "./store";
import { approvalGate, publishGate, createFactoryApprovals } from "./approval";
import { configuredLocalPublicationAdapters } from "./local-publication";
import { configuredVercelPublicationAdapters } from "./vercel-publication";
import { createFactoryCheckClaim, factoryCheckGates } from "./checks";
import { createFactoryMonitor, monitorGate } from "./monitor";
import { appendMonitorEvidence } from "./monitor-evidence";
import { workspaceDb } from "@/lib/workspace-db";
import { teamIssues } from "@/lib/db/team-schema";
import { eq } from "drizzle-orm";
import type { FactoryAuthorize } from "./store";
import { configuredMonitorProbes } from "./monitor-probe";
import { monitorWorkspacePartition } from "./monitor-fingerprint";

// Preserve existing personal/workspace/team/deletion access rules on every operation.
const authorize: FactoryAuthorize = async (userId, issueId, tx) => {
  // Reuse the held transaction: a second pool checkout here can deadlock
  // concurrent operations when the application connection pool is full.
  await tx.query("SELECT id FROM issues WHERE id=$1 FOR SHARE", [issueId]);
  const allowedIssue = await issueForUser(userId, issueId, false, drizzle(tx));
  const allowed = Boolean(allowedIssue);
  if (allowed) {
    const [link] = await workspaceDb.select({ workspaceId: teamIssues.workspaceId }).from(teamIssues).where(eq(teamIssues.issueId, issueId)).limit(1);
    await tx.query("SELECT set_config('mikka.audit_workspace',$1,true)", [allowedIssue?.scope === 'workspace' ? link?.workspaceId ?? `personal:${userId}` : `personal:${userId}`]);
  }
  return allowed;
};
export const factoryStore = createFactoryStore(pool, authorize, {
  ...factoryCheckGates,
  approval: approvalGate,
  publish: publishGate,
  monitor: monitorGate,
});
export const factoryApprovals = createFactoryApprovals(
  pool,
  authorize,
  factoryStore,
  [
    ...configuredLocalPublicationAdapters(process.env),
    ...configuredVercelPublicationAdapters(process.env),
  ],
);
export const claimFactoryCheckRun = createFactoryCheckClaim(pool, authorize);
export const factoryMonitor = createFactoryMonitor(
  pool,
  factoryStore,
  authorize,
  async (userId, issueId, tx) => {
    const [link] = await workspaceDb
      .select({ workspaceId: teamIssues.workspaceId })
      .from(teamIssues)
      .where(eq(teamIssues.issueId, issueId))
      .limit(1);
    const {
      rows: [issue],
    } = await tx.query(
      'SELECT i.scope,l."teamSyncId" FROM issues i LEFT JOIN linear_issue_links l ON l."issueId"=i.id WHERE i.id=$1',
      [issueId],
    );
    return monitorWorkspacePartition({
      userId,
      issueId,
      workspaceId: link?.workspaceId ?? null,
      issueScope: issue.scope,
      linearTeamSyncId: issue.teamSyncId ?? null,
    });
  },
  appendMonitorEvidence,
  configuredMonitorProbes(process.env),
);

import { queueRun } from "@/lib/agent-runs";
import { createFactoryDispatch } from "./dispatch";
import { factoryDispatchDatabase } from "./transaction";
export const dispatchFactoryRun = createFactoryDispatch(
  pool,
  factoryStore,
  (tx, userId, input) => queueRun(userId, input, factoryDispatchDatabase(tx)),
);
import { createFactoryQuestions } from "./questions/store";
export const factoryQuestions = createFactoryQuestions(
  pool,
  authorize,
  factoryStore,
  dispatchFactoryRun,
);
import { createFactoryReconciler } from "./reconcile";
export const reconcileFactoryRuns = createFactoryReconciler(
  pool,
  factoryStore,
  factoryQuestions,
);

import { createExecutionClaim } from "./execution-claim";
export const claimExecutionRun = createExecutionClaim(pool, authorize);
