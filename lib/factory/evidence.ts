import { createHash } from "node:crypto";
import { readSkillApprovalEvidence } from "../self-improvement/activation";
import type { PoolClient } from "pg";
import { evidenceSchema, FactoryError, type FactoryEvidence } from "./contract";
import type { FactoryCandidate, FactoryTask } from "./store";

export function digest(value: unknown): string {
  // JSONB canonical key ordering must survive DB round trips.
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object" && !(v instanceof Date))
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export const candidateIdentity = (c: FactoryCandidate) => ({
  sha: c.sha,
  repository: c.repository,
  environment: c.environment,
  scope: c.scope,
});

/** Defense in depth for existing text artifacts; never copy credentials into ledgers. */
export function redactArtifact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactArtifact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|token|secret|credential|authorization|cookie|api.?key/i.test(
          k,
        )
          ? "[REDACTED]"
          : redactArtifact(v),
      ]),
    );
  if (typeof value !== "string") return value;
  return value
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]")
    .replace(
      /\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|mka_[\w]+|mkr_[\w]+)\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(password|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}

/** Access only existing artifacts. A URL/model claim cannot create evidence. */
export async function readFactoryArtifact(
  tx: PoolClient,
  task: FactoryTask,
  ref: FactoryEvidence,
) {
  const {
    rows: [run],
  } = await tx.query(
    'SELECT id,"sessionId",status,"stopRequestedAt",report,"startedAt","finishedAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR SHARE',
    [ref.runId, task.userId, task.issueId],
  );
  if (
    !run ||
    run.status !== "succeeded" ||
    run.stopRequestedAt ||
    !run.sessionId ||
    run.sessionId !== ref.sessionId ||
    !run.startedAt ||
    !run.finishedAt
  )
    throw new FactoryError("factoryEvidenceMismatch");
  let raw: unknown;
  let sourceTime: Date = run.finishedAt;
  if (
    ref.kind === "report" &&
    ref.artifact === `run-report:${run.id}` &&
    run.report
  )
    raw = run.report;
  else if (
    ref.kind === "log" &&
    /^run-chunk:[a-f0-9-]{36}$/.test(ref.artifact)
  ) {
    const {
      rows: [chunk],
    } = await tx.query(
      'SELECT chunk,"createdAt" FROM run_chunks WHERE id=$1 AND "runId"=$2 FOR SHARE',
      [ref.artifact.slice(10), run.id],
    );
    if (!chunk) throw new FactoryError("factoryArtifactMissing");
    raw = chunk.chunk;
    sourceTime = chunk.createdAt;
  } else {
    // No screenshot/video store exists in the frozen baseline. Do not accept
    // arbitrary URLs as real artifacts; #193 can add a trusted reader later.
    throw new FactoryError("factoryArtifactMissing");
  }
  if (new Date(ref.recordedAt).getTime() < sourceTime.getTime())
    throw new FactoryError("factoryEvidenceMismatch");
  return {
    raw,
    sourceTime: sourceTime.toISOString(),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
  };
}

export async function approvalEvidence(tx: PoolClient, task: FactoryTask) {
  const {
    rows: [candidate],
  } = await tx.query<FactoryCandidate>(
    'SELECT * FROM factory_candidates WHERE id=$1 AND "taskId"=$2',
    [task.candidateId, task.id],
  );
  if (!candidate) throw new FactoryError("factoryEvidenceRequired");
  const skill = await readSkillApprovalEvidence(tx, task);
  const { rows } = await tx.query(
    "SELECT * FROM factory_attempts WHERE \"taskId\"=$1 AND \"candidateId\"=$2 AND stage IN ('execute','review','verify') ORDER BY position",
    [task.id, candidate.id],
  );
  const latest = ["execute", "review", "verify"].map((stage) =>
    rows.filter((a) => a.stage === stage).at(-1),
  );
  if (
    latest.some(
      (a) => !a || a.status !== "passed" || !a.runId || !a.sessionId,
    ) ||
    new Set(latest.map((a) => a?.runId)).size !== 3 ||
    new Set(latest.map((a) => a?.sessionId)).size !== 3
  )
    throw new FactoryError("factoryIndependentEvidenceRequired");
  const artifacts = [];
  for (const attempt of latest) {
    if (!attempt.evidence.length)
      throw new FactoryError("factoryEvidenceRequired");
    for (const value of attempt.evidence) {
      const parsed = evidenceSchema.safeParse(value);
      if (!parsed.success) throw new FactoryError("factoryEvidenceMismatch");
      const ref = parsed.data;
      if (
        ref.candidateId !== candidate.id ||
        ref.sha !== candidate.sha ||
        ref.environment !== candidate.environment ||
        ref.runId !== attempt.runId ||
        ref.sessionId !== attempt.sessionId
      )
        throw new FactoryError("factoryEvidenceMismatch");
      const source = await readFactoryArtifact(tx, task, ref);
      if (attempt.stage === "execute") {
        const {
          rows: [run],
        } = await tx.query(
          'SELECT report,"stopReason" FROM agent_runs WHERE id=$1',
          [ref.runId],
        );
        if (
          run.stopReason !== "submitted" ||
          run.report?.publish?.commit !== candidate.sha ||
          run.report?.verify?.status !== "passed"
        )
          throw new FactoryError("factoryEvidenceMismatch");
      }
      const { raw, ...timestamps } = source;
      artifacts.push({
        stage: attempt.stage,
        attemptId: attempt.id,
        ...ref,
        ...timestamps,
        sha256: digest(raw),
      });
    }
  }
  const manifest = {
    candidateId: candidate.id,
    candidate: candidateIdentity(candidate),
    artifacts,
    ...(skill ? { skill } : {}),
  };
  return {
    manifest,
    evidenceDigest: digest(manifest),
    evidence: artifacts.map(
      ({
        artifact,
        kind,
        runId,
        sessionId,
        candidateId,
        sha,
        environment,
        recordedAt,
      }) => ({
        artifact,
        kind,
        runId,
        sessionId,
        candidateId,
        sha,
        environment,
        recordedAt,
      }),
    ),
  };
}
