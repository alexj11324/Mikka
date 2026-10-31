import "server-only";
import { createSkillActivationAdapters } from "../self-improvement/activation";
import { ImprovementError } from "../self-improvement/contract";
import { FactoryError } from "./contract";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, withDatabaseClient } from "@/lib/db";
import { issueForUser } from "@/lib/issue-access";
import { lockCliAgentPolicy, lockCliRunPolicy } from "@/lib/agent-tool-approval/policy-store";
import { createFactoryStore } from "./store";
import { approvalGate, publishGate, createFactoryApprovals } from "./approval";
import { configuredLocalPublicationAdapters } from "./local-publication";
import { configuredVercelPublicationAdapters } from "./vercel-publication";
import { createFactoryCheckClaim, factoryCheckGates } from "./checks";
import { createFactoryMonitor, createFactoryMonitorRunConsumer, monitorGate } from "./monitor";
import { reconcileFactoryCheck } from "./reconcile-check";
import { appendMonitorEvidence } from "./monitor-evidence";
import { workspaceDb } from "@/lib/workspace-db";
import { teamIssues } from "@/lib/db/team-schema";
import { eq } from "drizzle-orm";
import type { FactoryAuthorize } from "./store";
import { configuredMonitorProbes } from "./monitor-probe";
import { monitorWorkspacePartition } from "./monitor-fingerprint";
import { createFactoryMonitorIssueLinks } from "./monitor-issue-links";
import { readAuthorizedIssue } from "../github/user-access";

// Preserve existing personal/workspace/team/deletion access rules on every operation.
const authorize: FactoryAuthorize = async (userId, issueId, tx) => {
  // Reuse the held transaction: a second pool checkout here can deadlock
  // concurrent operations when the application connection pool is full.
  await tx.query("SELECT id FROM issues WHERE id=$1 FOR SHARE", [issueId]);
  return Boolean(await issueForUser(userId, issueId, false, drizzle(tx)));
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
    ...createSkillActivationAdapters({
      readRegisteredCandidate: async (...args) =>
        (
          await import("../self-improvement/server")
        ).skillRegistry.readRegisteredCandidate(...args),
      passingEvaluation: async (...args) =>
        (
          await import("../self-improvement/server")
        ).skillEvaluations.passingEvaluation(...args),
    }),
  ],
);
export const claimFactoryCheckRun = createFactoryCheckClaim(pool, authorize);
export const factoryMonitorWorkspaceKey: Parameters<typeof createFactoryMonitor>[3] = async (userId, issueId, tx) => {
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
  };
export const factoryMonitor = createFactoryMonitor(
  pool,
  factoryStore,
  authorize,
  factoryMonitorWorkspaceKey,
  appendMonitorEvidence,
  configuredMonitorProbes(process.env),
);
export const factoryMonitorIssueLinks = createFactoryMonitorIssueLinks(pool, authorize, readAuthorizedIssue);

import { queueFactoryRun } from "@/lib/agent-runs";
import { createFactoryDispatch, defaultFactoryDispatchAdapters } from "./dispatch";
export const dispatchFactoryRun = createFactoryDispatch(
  pool,
  factoryStore,
  (tx, userId, input, botId, context) => queueFactoryRun(tx, userId, input, botId, context),
  {
    ...defaultFactoryDispatchAdapters,
    lockAdmission: async (tx,userId,input) => { await lockCliAgentPolicy(tx,userId,input.agentId,null); },
  },
);
import { createFactoryQuestions, type QuestionSkillGuards } from "./questions/store";
export const questionSkillAssignments: QuestionSkillGuards = {
  lockAnswer: async (userId,questionId,tx) => {
    // This is only a lock-order hint. owned()/fence() revalidate the exact
    // question, task and origin before a continuation can be created.
    const {rows:[question]}=await tx.query('SELECT "originRunId" FROM factory_questions WHERE id=$1 AND "userId"=$2',[questionId,userId]);
    if (!question) throw new FactoryError("factoryNotFound");
    try {
      await lockCliRunPolicy(tx,question.originRunId,userId);
    } catch (error) {
      if (error instanceof Error && error.message === "agentPolicyUnavailable")
        throw new FactoryError("factoryNotFound");
      throw error;
    }
  },
  lockOrigin: async (...args) => {
    try {
      await (await import("../self-improvement/server")).skillAssignments.lockQuestion(...args);
    } catch (error) {
      if (error instanceof ImprovementError)
        throw new FactoryError("factoryQuestionContinuationUnavailable");
      throw error;
    }
  },
  continueQuestion: async (...args) => {
    try {
      await (await import("../self-improvement/server")).skillAssignments.continueQuestion(...args);
    } catch (error) {
      if (error instanceof ImprovementError)
        throw new FactoryError("factoryQuestionContinuationUnavailable");
      throw error;
    }
  },
};
export const factoryQuestions = createFactoryQuestions(
  pool,
  authorize,
  factoryStore,
  dispatchFactoryRun,
  questionSkillAssignments,
);
import { createFactoryReconciler } from "./reconcile";
export const reconcileFactoryRuns = createFactoryReconciler(
  pool,
  factoryStore,
  factoryQuestions,
  {review:reconcileFactoryCheck,verify:reconcileFactoryCheck,monitor:createFactoryMonitorRunConsumer(factoryMonitor)},
);

import { createExecutionClaim, createExecutionClaimGuard } from "./execution-claim";
export const claimExecutionRun = createExecutionClaim(pool, authorize);

export const guardExecutionRun=createExecutionClaimGuard(authorize);

export function factoryRoutingEnabled() {
  return process.env.MIKKA_FACTORY_ROUTING_ENABLED === "1";
}
export function factoryForBot(botId: string | null) {
  if (!factoryRoutingEnabled())
    throw new FactoryError("factoryRoutingUnavailable");
  return createFactoryStore(
    pool,
    async (owner, issue, tx) =>
      withDatabaseClient(tx, async () => Boolean(await issueForUser(owner, issue))),
    botId,
  );
}
/** References are host records, never model-supplied provenance or approval. */
export async function factoryRequestSource(
  userId: string,
  botId: string | null,
  sourceEventId?: string,
) {
  if (!factoryRoutingEnabled())
    throw new FactoryError("factoryRoutingUnavailable");
  const { rows } = await pool.query(
    `SELECT e.id,e."createdAt",e.payload->>'text' AS text FROM coordinator_events e WHERE e."userId"=$1 AND e."botId" IS NOT DISTINCT FROM $2::uuid AND e.kind='user_message' AND e."issueId" IS NULL AND ($3::uuid IS NULL OR e.id=$3) AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=$2 AND b."ownerId"=$1)) ORDER BY e."createdAt" DESC,e.id DESC LIMIT 20`,
    [userId, botId, sourceEventId ?? null],
  );
  if (sourceEventId && rows.length !== 1)
    throw new FactoryError("factorySourceMismatch");
  return rows;
}
