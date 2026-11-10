import { bindFactoryStoreWorkspace, bindFactoryQuestionsWorkspace, factoryTaskWorkspaceBoundary, factoryBackgroundReference } from './background-workspace';
import { syncFactoryPresentation } from './stage-progress';
import { createFactorySpecApproval } from './spec-approval';
import { prepareCloudQuestionRecovery, queueCloudQuestionContinuation, wakeCloudQuestionContinuation } from './questions/queue-continuation';
import { queueLocalQuestionContinuation } from './questions/queue-local-continuation';
import "server-only";
import { deploymentSwitch } from '@/lib/deployment-switches'
import { createSkillActivationAdapters } from "../self-improvement/activation";
import { ImprovementError } from "../self-improvement/contract";
import { FactoryError } from "./contract";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, withDatabaseClient } from "@/lib/db";
import { issueForUser } from "@/lib/issue-access";
import { issueTeamAccess } from "@/lib/issue-team-access";
import { activeTaskWorkspaces, taskReaderScope } from "@/lib/task-workspace";
import { factoryWorkspaceReader } from './workspace-reader';
import { resourceActionAllowed } from '@/lib/resource-access/store';
import { lockCliAgentPolicy, prelockCliRunPolicy } from "@/lib/agent-tool-approval/policy-store";
import { createFactoryStore } from "./store";
import { createFactoryHumanStore } from './human-store';
import { createRetainedDeliverableObserver } from '../cloud-computer/retained-deliverable';
import { automaticFactoryDispatch } from './automatic-dispatch';
import { factoryCheckIndependent } from './check-independence';
import { approvalGate, publishGate, createFactoryApprovals } from "./approval";
import { createFactoryMerges, githubMergeApi } from "./merge";
import { createFactoryCheckClaim, factoryCheckGates } from "./checks";
import { createFactoryMonitor, createFactoryMonitorRunConsumer, monitorGate } from "./monitor";
import { reconcileFactoryCheck } from "./reconcile-check";
import { appendMonitorEvidence } from "./monitor-evidence";
import type { FactoryAuthorize } from "./store";
import { configuredMonitorProbes } from "./monitor-probe";
import { monitorWorkspacePartition } from "./monitor-fingerprint";
import { createFactoryMonitorIssueLinks } from "./monitor-issue-links";
import { readAuthorizedIssue } from "../github/user-access";

// Resolve the effective human tenant; background work uses persisted task authority.
const authorize: FactoryAuthorize = (userId, issueId, tx, lockedIssue) => withDatabaseClient(tx, async () => {
  // The human entry has already pinned WS/member before this APP transaction.
  // Canonical readers (including Enterprise) must reuse its APP connection.
  if (lockedIssue) {
    const reader = await factoryWorkspaceReader(userId);
    const workspaceId = taskReaderScope(reader).workspaceId;
    if (workspaceId) {
      if (lockedIssue.id !== issueId || lockedIssue.deleted !== false || lockedIssue.ownershipState !== 'bound'
        || lockedIssue.workspaceId !== workspaceId) return false;
      // The store supplied its current APP issue snapshot. Recheck links and
      // canonical authorization now; never reuse the route's preflight row.
      const link = await issueTeamAccess(issueId, userId);
      const allowed = await activeTaskWorkspaces(reader, workspaceId);
      return allowed.some(workspace => workspace.id === workspaceId)
        && (!link.linked || link.workspaceId === workspaceId)
        && await resourceActionAllowed(drizzle(tx), userId, { kind: 'task', id: issueId, workspaceId }, 'canReadContent');
    }
    return Boolean(await issueForUser(reader, issueId, false, drizzle(tx)));
  }
  await tx.query("SELECT id FROM issues WHERE id=$1 FOR SHARE", [issueId]);
  return Boolean(await issueForUser(await factoryWorkspaceReader(userId), issueId, false, drizzle(tx)));
});
const humanGates = {
  ...factoryCheckGates,
  approval: approvalGate,
  publish: publishGate,
  monitor: monitorGate,
};
const backgroundWorkspace = factoryTaskWorkspaceBoundary(pool, null);
export const factoryStore = bindFactoryStoreWorkspace(pool, createFactoryStore(pool, authorize, humanGates, { onTransition: syncFactoryPresentation }), null);
const humanStoreForBot = (botId: string | null) => createFactoryStore(pool, authorize, botId, { sharedReads: true, independent: factoryCheckIndependent, gates: humanGates, onTransition: syncFactoryPresentation });
export const factoryHumanStore = createFactoryHumanStore(pool, humanStoreForBot, automaticFactoryDispatch(pool),
  createRetainedDeliverableObserver(pool, (tx, scope) => humanStoreForBot(scope.botId).lockTask(tx, scope.ownerId, scope.taskId)));
// #528: a code candidate is accepted by the person's merge of its PR
// (factoryMerges); deploy_preview/deploy_production are not Factory steps. Only a
// skill candidate, which has no PR, is still approved and activated here.
export const factoryApprovals = createFactoryApprovals(
  pool,
  authorize,
  factoryHumanStore,
  [
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
  { codeCandidatesMerge: true },
);
export const factorySpecApproval = createFactorySpecApproval(pool, factoryHumanStore, automaticFactoryDispatch(pool));
export const factoryMerges = createFactoryMerges(pool, authorize, factoryHumanStore, githubMergeApi());
export const claimFactoryCheckRun = createFactoryCheckClaim(pool, authorize);
export const factoryMonitorWorkspaceKey: Parameters<typeof createFactoryMonitor>[3] = async (userId, issueId, tx) => {
    const {
      rows: [issue],
    } = await tx.query(
      'SELECT i.scope,i."workspaceId",l."teamSyncId" FROM issues i LEFT JOIN linear_issue_links l ON l."issueId"=i.id WHERE i.id=$1 AND i."ownershipState"=\'bound\'',
      [issueId],
    );
    if (!issue?.workspaceId) throw new FactoryError('factoryNotFound');
    return monitorWorkspacePartition({
      userId,
      issueId,
      workspaceId: issue.workspaceId,
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
  null,
  backgroundWorkspace,
);
export const factoryMonitorIssueLinks = createFactoryMonitorIssueLinks(pool, authorize, readAuthorizedIssue);

import { queueFactoryRun } from "@/lib/agent-runs";
import { createFactoryDispatch, defaultFactoryDispatchAdapters } from "./dispatch";
const dispatchFactoryRunWithinWorkspace = createFactoryDispatch(
  pool,
  factoryStore,
  async (tx, userId, input, botId, context) => await queueCloudQuestionContinuation(tx,userId,input,botId,context) ?? await queueLocalQuestionContinuation(tx,userId,input,botId,context) ?? queueFactoryRun(tx, userId, input, botId, context),
  {
    ...defaultFactoryDispatchAdapters,
    lockAdmission: async (tx,userId,input) => { await lockCliAgentPolicy(tx,userId,input.agentId,null); },
  },
);
export const dispatchFactoryRun: typeof dispatchFactoryRunWithinWorkspace = (...args) =>
  backgroundWorkspace(args[0], factoryBackgroundReference(args[1], 'taskId'), () => dispatchFactoryRunWithinWorkspace(...args), args[2]);
import { createFactoryQuestions, type QuestionSkillGuards } from "./questions/store";
export const questionSkillAssignments: QuestionSkillGuards = {
  lockAnswer: async (userId,questionId,tx) => {
    // This is only a lock-order hint. owned()/fence() revalidate the exact
    // question, task and origin before a continuation can be created.
    const {rows:[question]}=await tx.query('SELECT "originRunId" FROM factory_questions WHERE id=$1 AND "userId"=$2',[questionId,userId]);
    if (!question) throw new FactoryError("factoryNotFound");
    const {rows:[cloud]}=await tx.query('SELECT "workspaceId" FROM computer_run_bindings WHERE "runId"=$1 AND "ownerId"=$2',[question.originRunId,userId]);
    // Cloud claim and runtime maintenance acquire policy before task/run locks.
    if (cloud) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`computer-policy:${cloud.workspaceId}`]);
    try {
      await prelockCliRunPolicy(tx,question.originRunId,userId);
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
export const factoryQuestions = bindFactoryQuestionsWorkspace(pool, createFactoryQuestions(
  pool,
  authorize,
  factoryStore,
  dispatchFactoryRun,
  questionSkillAssignments,
  undefined,
  (userId,result)=>wakeCloudQuestionContinuation(pool,userId,result),
  (userId,scope)=>prepareCloudQuestionRecovery(pool,userId,scope),
), null);
import { createFactoryReconciler } from "./reconcile";
export const reconcileFactoryRuns = createFactoryReconciler(
  pool,
  factoryStore,
  factoryQuestions,
  {review:reconcileFactoryCheck,verify:reconcileFactoryCheck,monitor:createFactoryMonitorRunConsumer(factoryMonitor)},
  null,
  undefined,
  backgroundWorkspace,
);

import { createExecutionClaim, createExecutionClaimGuard } from "./execution-claim";
export const claimExecutionRun = createExecutionClaim(pool, authorize);

export const guardExecutionRun=createExecutionClaimGuard(authorize);

export function factoryRoutingEnabled() {
  return deploymentSwitch('factoryRouting');
}
export function factoryForBot(botId: string | null) {
  if (!factoryRoutingEnabled())
    throw new FactoryError("factoryRoutingUnavailable");
  return bindFactoryStoreWorkspace(pool, createFactoryStore(
    pool,
    async (owner, issue, tx) =>
      withDatabaseClient(tx, async () => Boolean(await issueForUser(owner, issue))),
    botId,
    { onTransition: syncFactoryPresentation },
  ), botId);
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
