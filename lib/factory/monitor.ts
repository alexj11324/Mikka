import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { bindingSchema, FactoryError, type FactoryBinding } from "./contract";
import { factoryEventId } from "./event-id";
import { monitorFingerprint } from "./monitor-fingerprint";
import { readFactoryPublicationReceipt } from "./publication-receipt";
import { digest } from "./evidence";
import {
  createMonitorProbeRecorder,
  monitorProbePassed,
  validatedMonitorProof,
  type MonitorProbeAdapter,
  type MonitorPublication,
} from "./monitor-probe";
import type {
  createFactoryStore,
  FactoryAuthorize,
  FactoryGate,
  FactoryTask,
} from "./store";

const inputSchema = z
  .object({ binding: bindingSchema, sourceEventId: z.uuid() })
  .strict();
export type MonitorInput = z.infer<typeof inputSchema>;
export type MonitorNotice = {
  observationId: string;
  sourceEventId: string;
  taskId: string;
  issueId: string;
  candidateId: string;
  runId: string;
  sessionId: string;
  sha: string;
  environment: string;
  outcome: "failed" | "passed" | "blocked";
  incidentId: string | null;
  fingerprint: string | null;
  occurrences: number;
  transitionBlocked: boolean;
  publicationId?: string;
  target?: string;
  targetEnvironment?: string;
  operationId?: string;
  checkedReference?: string;
  kind?: string;
};
function fail(code: string): never {
  throw new FactoryError(code);
}
const bindingFor = (task: FactoryTask): FactoryBinding => ({
  taskId: task.id,
  issueId: task.issueId,
  attemptId: task.attemptId,
  revision: task.revision,
  candidateId: task.candidateId,
});

/** #195 only. Other consumers remain closed until their own trusted validators are installed. */
export const monitorGate: FactoryGate = async (tx, task, attempt, change) => {
  if (task.stage !== "monitor" || !task.candidateId) return false;
  const {
    rows: [observation],
  } = await tx.query(
    `SELECT o.*,r.report,r.status AS "runStatus",r."stopReason",r."stopRequestedAt",r."startedAt",r."finishedAt",
      c.sha,c.environment,c."runId" AS "executeRunId",execution."sessionId" AS "executeSessionId"
     FROM factory_monitor_observations o
     JOIN factory_candidates c ON c.id=o."candidateId" AND c."taskId"=o."taskId"
     JOIN agent_runs execution ON execution.id=c."runId" AND execution."userId"=o."userId" AND execution."issueId"=$5
     JOIN agent_runs r ON r.id=o."runId" AND r."userId"=o."userId" AND r."issueId"=$5 AND r."sessionId"=o."sessionId"
     JOIN coordinator_events e ON e.id=o."sourceEventId" AND e.kind='run_finished' AND e."userId"=o."userId" AND e."runId"=r.id AND e."issueId"=r."issueId"
     WHERE o.id=$1 AND o."userId"=$2 AND o."taskId"=$3 AND o."candidateId"=$4 AND o.evidence=$6::jsonb`,
    [
      change.output.monitorObservationId,
      task.userId,
      task.id,
      task.candidateId,
      task.issueId,
      JSON.stringify(change.evidence),
    ],
  );
  if (
    !observation ||
    observation.outcome !== "passed" ||
    attempt.runId !== observation.runId ||
    observation.runStatus !== "succeeded" ||
    observation.stopRequestedAt ||
    observation.stopReason !== "submitted" ||
    observation.report?.verify?.status !== "passed" ||
    !observation.report?.verify?.command ||
    observation.report?.verify?.exitCode !== 0 ||
    observation.report?.verify?.timedOut !== false ||
    observation.report?.verify?.signal !== null ||
    (observation.report?.check &&
      (observation.report.check.sha !== observation.sha ||
        observation.report.check.readOnly !== true)) ||
    observation.report?.filesChanged?.length !== 0
  )
    return false;
  let publication: MonitorPublication;
  try {
    publication = await readFactoryPublicationReceipt(
      tx,
      task.userId,
      task.id,
      task.candidateId,
    );
  } catch (error) {
    if (error instanceof FactoryError) return false;
    throw error;
  }
  const proof = await validatedMonitorProof(tx, task, attempt, publication, {
    id: observation.runId,
    sessionId: observation.sessionId,
    startedAt: observation.startedAt,
    finishedAt: observation.finishedAt,
  });
  if (
    !proof ||
    !monitorProbePassed(proof.audit, publication) ||
    !change.output.monitorAudit ||
    digest(change.output.monitorAudit) !== digest(proof.audit)
  )
    return false;
  const { rows: stages } = await tx.query(
    `SELECT DISTINCT ON (stage) * FROM factory_attempts WHERE "taskId"=$1 AND "candidateId"=$2
      AND stage IN ('review','verify','approval','publish') AND position<$3 ORDER BY stage,position DESC`,
    [task.id, task.candidateId, attempt.position],
  );
  if (
    stages.length !== 4 ||
    stages.some((s) => s.status !== "passed" || !s.evidence.length)
  )
    return false;
  const review = stages.find((s) => s.stage === "review")!;
  const verify = stages.find((s) => s.stage === "verify")!;
  const publish = stages.find((s) => s.stage === "publish")!;
  // A passed daemon report alone cannot bypass independent verification or human publication gates.
  const runIds = [
    observation.executeRunId,
    review.runId,
    verify.runId,
    observation.runId,
  ];
  if (
    runIds.some((id) => !id) ||
    new Set(runIds).size !== runIds.length ||
    !review.sessionId ||
    !verify.sessionId ||
    !observation.executeSessionId ||
    new Set([
      observation.executeSessionId,
      review.sessionId,
      verify.sessionId,
      observation.sessionId,
    ]).size !== 4 ||
    !publish.finishedAt ||
    !observation.finishedAt ||
    observation.finishedAt < publish.finishedAt
  )
    return false;
  for (const stage of [review, verify]) {
    const {
      rows: [run],
    } = await tx.query(
      `SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 AND "sessionId"=$4 AND status='succeeded' AND "stopRequestedAt" IS NULL`,
      [stage.runId, task.userId, task.issueId, stage.sessionId],
    );
    if (
      !run ||
      !stage.evidence.every(
        (e: { candidateId: string; sha: string; environment: string }) =>
          e.candidateId === task.candidateId &&
          e.sha === observation.sha &&
          e.environment === observation.environment,
      )
    )
      return false;
  }
  return true;
};

/** Existing events + existing Factory store. No timers, external writes, dispatch or wake implementation. */
export function createFactoryMonitor(
  pool: Pool,
  store: ReturnType<typeof createFactoryStore>,
  authorize: FactoryAuthorize,
  workspaceKey: (
    userId: string,
    issueId: string,
    tx: PoolClient,
  ) => Promise<string>,
  appendEvidence: (
    tx: PoolClient,
    notice: MonitorNotice,
  ) => Promise<void> = async () => {},
  probes: MonitorProbeAdapter[] = [],
) {
  async function consume(
    userId: string,
    raw: MonitorInput,
  ): Promise<MonitorNotice & { replayed: boolean }> {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) fail("factoryInvalid");
    const input = parsed.data;
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const {
        rows: [task],
      } = await tx.query<FactoryTask>(
        'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE',
        [input.binding.taskId, userId],
      );
      // Serialize the owner's document writes before authorize takes issue SHARE locks.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify(["factory-monitor-owner", userId]),
      ]);
      if (task)
        await tx.query("SELECT id FROM issues WHERE id=$1 FOR UPDATE", [
          task.issueId,
        ]);
      if (
        !task ||
        task.issueId !== input.binding.issueId ||
        !(await authorize(userId, task.issueId, tx))
      )
        fail("factoryNotFound");
      if (["cancelled", "revoked"].includes(task.status))
        fail("factoryStopped");
      const scope = await workspaceKey(userId, task.issueId, tx);
      const {
        rows: [prior],
      } = await tx.query(
        'SELECT *,request=$3::jsonb AS same FROM factory_monitor_observations WHERE "userId"=$1 AND "sourceEventId"=$2 FOR UPDATE',
        [userId, input.sourceEventId, JSON.stringify(input)],
      );
      if (prior) {
        if (!prior.same || prior.workspaceKey !== scope)
          fail("factoryReplayMismatch");
        const notice = prior.result as MonitorNotice;
        if (!(await authorize(userId, notice.issueId, tx)))
          fail("factoryNotFound");
        await tx.query(
          "UPDATE factory_monitor_observations SET deliveries=deliveries+1 WHERE id=$1",
          [prior.id],
        );
        await tx.query("COMMIT");
        return { ...notice, replayed: true };
      }
      if (JSON.stringify(bindingFor(task)) !== JSON.stringify(input.binding)) {
        // Compare fields, not the caller's property order.
        for (const key of Object.keys(
          input.binding,
        ) as (keyof FactoryBinding)[]) {
          if (bindingFor(task)[key] !== input.binding[key])
            fail("factoryStale");
        }
      }
      if (task.stage !== "monitor" || !task.candidateId)
        fail("factoryTransition");
      const {
        rows: [source],
      } = await tx.query(
        `SELECT r.*,e.id AS "sourceEventId",c.sha,c.repository,c.environment,c.scope,
          a.id AS "monitorAttemptId",a.position AS "monitorPosition",a.output AS "monitorOutput"
         FROM coordinator_events e JOIN agent_runs r ON r.id=e."runId" AND r."userId"=e."userId" AND r."issueId"=e."issueId"
         JOIN factory_attempts a ON a."runId"=r.id AND a.id=$4 AND a."taskId"=$3
         JOIN factory_candidates c ON c.id=$5 AND c."taskId"=$3
         WHERE e.id=$1 AND e."userId"=$2 AND e."issueId"=$6 AND e.kind='run_finished' FOR SHARE OF r`,
        [
          input.sourceEventId,
          userId,
          task.id,
          task.attemptId,
          task.candidateId,
          task.issueId,
        ],
      );
      if (
        !source ||
        !source.report ||
        !source.sessionId ||
        !source.finishedAt ||
        source.stopRequestedAt ||
        !["succeeded", "failed"].includes(source.status) ||
        !["submitted", "error", "timeout"].includes(source.stopReason)
      )
        fail("factoryMonitorSourceMismatch");
      let publication: MonitorPublication | undefined;
      try {
        publication = await readFactoryPublicationReceipt(
          tx,
          userId,
          task.id,
          task.candidateId,
        );
      } catch (error) {
        if (!(error instanceof FactoryError)) throw error;
      }
      const attempt = {
        id: task.attemptId,
        taskId: task.id,
        stage: "monitor" as const,
        ordinal: 1,
        position: source.monitorPosition,
        status: task.status,
        candidateId: task.candidateId,
        runId: source.id,
        sessionId: source.sessionId,
        reason: task.reason,
        output: source.monitorOutput,
        evidence: [],
      };
      const proof = publication
        ? await validatedMonitorProof(tx, task, attempt, publication, source)
        : undefined;
      const failed = Boolean(
        proof &&
        !proof.audit.timedOut &&
        !proof.audit.signal &&
        ["content-mismatch", "missing"].includes(proof.audit.errorCode ?? ""),
      );
      const initialOutcome: MonitorNotice["outcome"] = failed
        ? "failed"
        : publication &&
            proof &&
            monitorProbePassed(proof.audit, publication) &&
            source.status === "succeeded" &&
            source.report.verify.status === "passed"
          ? "passed"
          : "blocked";
      const keys = monitorFingerprint({
        userId,
        workspaceKey: scope,
        repository: source.repository,
        environment: publication?.targetEnvironment ?? "unverified",
        target: publication
          ? JSON.stringify([
              publication.verifiedTarget.kind,
              publication.target,
            ])
          : `unverified:${task.id}:${task.candidateId}`,
        component: source.scope,
        check: "registered-target-readback-v1",
        failure: proof?.audit.errorCode ?? "probe-or-publication-unverified",
      });
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([userId, scope, keys.checkKey]),
      ]);
      let incidentId: string | null = null;
      if (failed) {
        const {
          rows: [incident],
        } = await tx.query(
          `INSERT INTO factory_monitor_incidents (id,"userId","workspaceKey",fingerprint,"checkKey","issueId","taskId","candidateId",occurrences)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)
           ON CONFLICT ("userId","workspaceKey",fingerprint) DO UPDATE SET occurrences=factory_monitor_incidents.occurrences+1,status='open',"recoveredObservationId"=NULL,"updatedAt"=now() RETURNING *`,
          [
            randomUUID(),
            userId,
            scope,
            keys.fingerprint,
            keys.checkKey,
            task.issueId,
            task.id,
            task.candidateId,
          ],
        );
        if (!(await authorize(userId, incident.issueId, tx)))
          fail("factoryNotFound");
        incidentId = incident.id;
      }
      const id = randomUUID();
      const evidence: import("./contract").FactoryEvidence[] = [
        {
          artifact: `run-report:${source.id}`,
          kind: "report" as const,
          runId: source.id,
          sessionId: source.sessionId,
          candidateId: task.candidateId,
          sha: source.sha,
          environment: source.environment,
          recordedAt: source.finishedAt.toISOString(),
        },
      ];
      if (proof)
        evidence.push({
          ...evidence[0],
          artifact: proof.artifact,
          kind: "log",
          recordedAt: proof.audit.finishedAt,
        });
      await tx.query(
        `INSERT INTO factory_monitor_observations (id,"userId","workspaceKey","sourceEventId","runId","sessionId","taskId","candidateId","incidentId","checkKey",request,evidence,outcome)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          userId,
          scope,
          input.sourceEventId,
          source.id,
          source.sessionId,
          task.id,
          task.candidateId,
          incidentId,
          keys.checkKey,
          JSON.stringify(input),
          JSON.stringify(evidence),
          initialOutcome,
        ],
      );
      const change = {
        action: "finish" as const,
        status: failed ? ("failed" as const) : ("passed" as const),
        reason: failed
          ? "Persisted monitor failure; original issue retained"
          : "Same-candidate recovery checked after independent verification and approved publication",
        evidence,
        output: {
          ...source.monitorOutput,
          monitorObservationId: id,
          ...(proof ? { monitorAudit: proof.audit } : {}),
        },
      };
      let outcome: MonitorNotice["outcome"] = initialOutcome;
      if (
        outcome === "passed" &&
        !(await monitorGate(tx, task, attempt, change))
      ) {
        outcome = "blocked";
        await tx.query(
          "UPDATE factory_monitor_observations SET outcome='blocked' WHERE id=$1",
          [id],
        );
      }
      const transitionBlocked = !["pending", "running", "waiting"].includes(
        task.status,
      );
      if (!transitionBlocked)
        await store.apply(
          userId,
          input.binding,
          factoryEventId("monitor", input.sourceEventId),
          {
            ...change,
            status: outcome,
            reason:
              outcome === "blocked"
                ? "Recovery lacks exact candidate, independent verification or approved publication evidence"
                : change.reason,
          },
          tx,
        );
      if (outcome === "passed" && !transitionBlocked) {
        const { rows: open } = await tx.query(
          'SELECT "issueId" FROM factory_monitor_incidents WHERE "userId"=$1 AND "workspaceKey"=$2 AND "checkKey"=$3 AND status=\'open\' FOR UPDATE',
          [userId, scope, keys.checkKey],
        );
        for (const row of open)
          if (!(await authorize(userId, row.issueId, tx)))
            fail("factoryNotFound");
        await tx.query(
          'UPDATE factory_monitor_incidents SET status=\'recovered\',"recoveredObservationId"=$4,"updatedAt"=now() WHERE "userId"=$1 AND "workspaceKey"=$2 AND "checkKey"=$3 AND status=\'open\'',
          [userId, scope, keys.checkKey, id],
        );
      }
      const {
        rows: [observation],
      } = await tx.query(
        "SELECT * FROM factory_monitor_observations WHERE id=$1",
        [id],
      );
      const notice = {
        ...(await noticeFor(tx, observation)),
        transitionBlocked,
        ...(publication
          ? {
              publicationId: publication.publicationId,
              target: publication.target,
              targetEnvironment: publication.targetEnvironment,
              operationId: publication.verifiedTarget.operationId,
              checkedReference: publication.reference,
              kind: publication.verifiedTarget.kind,
            }
          : {}),
      };
      await tx.query(
        "UPDATE factory_monitor_observations SET result=$2 WHERE id=$1",
        [id, JSON.stringify(notice)],
      );
      await tx.query(
        `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload,tier)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("dedupeKey") DO NOTHING`,
        [
          factoryEventId("monitor-notice", id),
          userId,
          outcome === "passed" && !transitionBlocked
            ? "run_report"
            : "run_blocked",
          `factory-monitor:${id}`,
          notice.issueId,
          source.id,
          JSON.stringify({
            ...notice,
            origin: "factory-monitor",
            text: `Factory monitor ${outcome}; evidence ${id}`,
            reason: transitionBlocked
              ? "factoryMonitorTransitionBlocked: contract coordination required"
              : `Factory monitor ${outcome}`,
          }),
          outcome === "passed" && !transitionBlocked ? "result" : "attention",
        ],
      );
      await appendEvidence(tx, notice);
      await tx.query("COMMIT");
      return { ...notice, replayed: false };
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  return {
    consume,
    probeRun: createMonitorProbeRecorder(pool, authorize, probes),
    /** Called by the existing Coordinator reconciliation; #176 retains ownership of waking it. */
    async reconcile(userId: string) {
      const { rows } = await pool.query(
        `SELECT t.*,e.id AS "monitorEventId" FROM factory_tasks t
         JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
         JOIN coordinator_events e ON e."runId"=a."runId" AND e."userId"=t."userId" AND e."issueId"=t."issueId" AND e.kind='run_finished'
         WHERE t."userId"=$1 AND t.stage='monitor' AND t.status NOT IN ('cancelled','revoked')
         AND NOT EXISTS (SELECT 1 FROM factory_monitor_observations o WHERE o."userId"=$1 AND o."sourceEventId"=e.id)
         ORDER BY e."createdAt" LIMIT 50`,
        [userId],
      );
      let observed = 0;
      for (const task of rows) {
        try {
          await consume(userId, {
            binding: bindingFor(task),
            sourceEventId: task.monitorEventId,
          });
          observed++;
        } catch (error) {
          if (
            !(error instanceof FactoryError) ||
            ![
              "factoryNotFound",
              "factoryStopped",
              "factoryStale",
              "factoryMonitorSourceMismatch",
            ].includes(error.code)
          )
            throw error;
        }
      }
      return { observed };
    },
  };
}

async function noticeFor(
  tx: PoolClient,
  observation: {
    id: string;
    sourceEventId: string;
    taskId: string;
    candidateId: string;
    runId: string;
    sessionId: string;
    incidentId: string | null;
    outcome: MonitorNotice["outcome"];
    evidence: { sha: string; environment: string }[];
  },
): Promise<MonitorNotice> {
  const {
    rows: [incident],
  } = await tx.query("SELECT * FROM factory_monitor_incidents WHERE id=$1", [
    observation.incidentId,
  ]);
  const {
    rows: [task],
  } = await tx.query('SELECT "issueId",status FROM factory_tasks WHERE id=$1', [
    observation.taskId,
  ]);
  return {
    observationId: observation.id,
    sourceEventId: observation.sourceEventId,
    taskId: observation.taskId,
    issueId: incident?.issueId ?? task.issueId,
    candidateId: observation.candidateId,
    runId: observation.runId,
    sessionId: observation.sessionId,
    sha: observation.evidence[0].sha,
    environment: observation.evidence[0].environment,
    outcome: observation.outcome,
    incidentId: incident?.id ?? null,
    fingerprint: incident?.fingerprint ?? null,
    occurrences: incident?.occurrences ?? 0,
    transitionBlocked: false,
  };
}
