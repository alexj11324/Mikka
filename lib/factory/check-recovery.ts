import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { orchestratorSettings } from "@mikka/protocol/orchestrator";
import { bindingSchema, FactoryError } from "./contract";
import { factoryEventId } from "./event-id";
import { factoryBinding } from "./dispatch";
import type { createFactoryStore, FactorySnapshot } from "./store";

/** Model judgment only. Identity, capability and permissions are never tool inputs. */
export const factoryCheckRecoverySchema = z
  .object({
    binding: bindingSchema,
    choice: z.enum(["retry_check", "repair_code"]),
    rationale: z.string().trim().min(1).max(4000),
  })
  .strict();
export type FactoryCheckRecoveryInput = z.infer<
  typeof factoryCheckRecoverySchema
>;
export const FACTORY_CHECK_RECOVERY_CONTRACT_VERSION = 1 as const;

/** Supplied by the existing host model resolver/tool execution context, not the model.
 * The current resolver needs a verified vision-capability seam; absence cannot be
 * replaced by an asserted tool argument, model-name heuristic or human approval. */
export interface FactoryRecoveryJudge {
  callId: string;
  executionId: string;
  modelId: string;
  vision: "verified";
}
function fail(code: string): never {
  throw new FactoryError(code);
}

export function createFactoryCheckRecovery(
  pool: Pool,
  store: ReturnType<typeof createFactoryStore>,
) {
  return async (
    userId: string,
    raw: unknown,
    judge: FactoryRecoveryJudge | undefined,
    existing?: PoolClient,
  ): Promise<FactorySnapshot> => {
    const parsed = factoryCheckRecoverySchema.safeParse(raw);
    if (!parsed.success) fail("factoryInvalid");
    if (
      !judge ||
      judge.vision !== "verified" ||
      !judge.callId ||
      !judge.executionId ||
      !judge.modelId
    )
      fail("factoryVisionModelProvenanceRequired");
    const input = parsed.data,
      tx = existing ?? (await pool.connect());
    try {
      if (!existing) await tx.query("BEGIN");
      const task = await store.lockTask(tx, userId, input.binding.taskId);
      if (task.issueId !== input.binding.issueId) fail("factoryNotFound");
      if (["cancelled", "revoked"].includes(task.status))
        fail("factoryStopped");
      const eventId = factoryEventId("check-recovery-model", judge.callId);
      const request = { kind: "factory_check_recovery", input, judge };
      const {
        rows: [prior],
      } = await tx.query<{ same: boolean; result: FactorySnapshot }>(
        'SELECT request=$3::jsonb AS same,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
        [task.id, eventId, JSON.stringify(request)],
      );
      if (prior) {
        if (!prior.same) fail("factoryReplayMismatch");
        if (
          task.revision !== prior.result.task.revision ||
          task.attemptId !== prior.result.task.attemptId ||
          task.candidateId !== prior.result.task.candidateId
        )
          fail("factoryStale");
        if (!existing) await tx.query("COMMIT");
        return prior.result;
      }
      const current = factoryBinding(task);
      if (
        Object.entries(current).some(
          ([key, value]) =>
            input.binding[key as keyof typeof current] !== value,
        )
      )
        fail("factoryStale");
      if (
        !["failed", "blocked"].includes(task.status) ||
        !["review", "verify"].includes(task.stage) ||
        !task.candidateId
      )
        fail("factoryTransition");
      const {
        rows: [attempt],
      } = await tx.query(
        'SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2 FOR UPDATE',
        [task.attemptId, task.id],
      );
      const {
        rows: [finish],
      } = await tx.query(
        'SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
        [task.id, factoryEventId("check-completion", attempt?.runId ?? "")],
      );
      const {
        rows: [run],
      } = await tx.query(
        'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE',
        [attempt?.runId, userId, task.issueId],
      );
      const {
        rows: [candidate],
      } = await tx.query(
        'SELECT * FROM factory_candidates WHERE id=$1 AND "taskId"=$2',
        [task.candidateId, task.id],
      );
      const check = attempt?.output?.check,
        report = run?.report,
        receipt = finish?.result?.task;
      // Mechanical provenance only: the recorded failed finish already passed the
      // shared strict ancestry predicate. Do not reinterpret its failure's cause.
      if (
        !attempt ||
        attempt.status !== task.status ||
        attempt.stage !== task.stage ||
        attempt.candidateId !== task.candidateId ||
        !run ||
        !["succeeded", "failed", "stopped"].includes(run.status) ||
        run.stopRequestedAt ||
        ["cancelled", "revoked"].includes(run.stopReason) ||
        run.retryOf ||
        run.botId !== task.botId ||
        !run.sessionId ||
        run.sessionId !== attempt.sessionId ||
        !candidate ||
        receipt?.id !== task.id ||
        receipt.attemptId !== attempt.id ||
        receipt.candidateId !== candidate.id ||
        receipt.stage !== task.stage ||
        receipt.status !== task.status ||
        attempt.output?.completion?.trustedFailureProvenance !== true ||
        attempt.output.completion.runId !== run.id ||
        check?.stage !== task.stage ||
        check.candidateId !== candidate.id ||
        run.kind !== "acceptance" ||
        run.baseBranch !== candidate.sha ||
        check.sha !== candidate.sha ||
        check.repository !== candidate.repository ||
        check.environment !== candidate.environment ||
        check.deviceRepoId !== run.deviceRepoId ||
        !check.command ||
        report?.check?.sha !== candidate.sha ||
        report.check.readOnly !== true ||
        report.verify?.command !== check.command ||
        !(
          Number.isFinite(report.verify?.exitCode) ||
          report.verify?.exitCode === null
        ) ||
        !isDeepStrictEqual(
          attempt.output,
          finish.result.attempts.find(
            (a: { id: string }) => a.id === attempt.id,
          )?.output,
        ) ||
        !isDeepStrictEqual(report.check, attempt.output.completion.check) ||
        !isDeepStrictEqual(report.verify, attempt.output.completion.verify) ||
        run.stopReason !== attempt.output.completion.stopReason ||
        run.error !== attempt.output.completion.error
      )
        fail("factoryCheckBindingMismatch");
      const {
        rows: [budget],
      } = await tx.query(
        `SELECT count(*)::int AS count FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='factory_check_recovery' AND request->'input'->'binding'->>'candidateId'=$2`,
        [task.id, task.candidateId],
      );
      if (budget.count >= orchestratorSettings({}).maxFixAttempts)
        fail("factoryRecoveryBudgetExceeded");
      if (input.choice === "repair_code") {
        const {
          rows: [executions],
        } = await tx.query(
          `SELECT count(*)::int AS count FROM factory_attempts WHERE "taskId"=$1 AND stage='execute'`,
          [task.id],
        );
        if (executions.count > orchestratorSettings({}).maxFixAttempts)
          fail("factoryRecoveryBudgetExceeded");
      }
      const result = await store.apply(
        userId,
        input.binding,
        factoryEventId("check-recovery-apply", judge.callId),
        {
          action: input.choice === "retry_check" ? "retry" : "repair",
          reason: input.rationale,
        },
        tx,
      );
      const recovery = {
        choice: input.choice,
        rationale: input.rationale,
        judge,
        failedAttemptId: attempt.id,
        failedRunId: run.id,
        candidateId: candidate.id,
      };
      await tx.query(
        "UPDATE factory_attempts SET output=output || $2::jsonb WHERE id=$1",
        [result.task.attemptId, JSON.stringify({ recovery })],
      );
      for (const next of result.attempts)
        if (next.id === result.task.attemptId)
          next.output = { ...next.output, recovery };
      await tx.query(
        'INSERT INTO factory_events("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)',
        [task.id, eventId, JSON.stringify(request), JSON.stringify(result)],
      );
      if (!existing) await tx.query("COMMIT");
      return result;
    } catch (error) {
      if (!existing) await tx.query("ROLLBACK");
      throw error;
    } finally {
      if (!existing) tx.release();
    }
  };
}

export const FACTORY_CHECK_RECOVERY_INSTRUCTIONS = `
Assess failed Factory review/verify observations using the original persisted report, command, exit status, chunks and candidate. A vision-capable model owns the recovery judgment: choose retry_check for a justified retry of the same fixed candidate, or repair_code when the evidence calls for source work. Do not classify failures by programmatic error-text rules, require a new commit for every failure, or ask a human for every recovery. For visual judgments, inspect actual accessible images through existing granted tools; text descriptions do not replace them. Missing visual evidence keeps that assessment unresolved. Use recover_factory_check with the exact current binding and rationale. Existing permissions, ask/deny policy, cancellation, identity, budget and frozen grants still apply; the model cannot authorize itself. No result here authorizes publication.\n`;
