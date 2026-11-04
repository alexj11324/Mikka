import { repositoryExecutionMatches } from './execution-receipt'
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  evidenceSchema,
  FactoryError,
  type FactoryEvidence,
} from "./approval-contract";
import type { FactoryCandidate, FactoryTask } from "./approval-dependencies";
import { maskCredentials } from "../secrets/mask";
import { factoryEventId } from './event-id';

/** What a screenshot or recording entry shown to the reviewer carries. */
export interface FactoryCaptureEvidence {
  captureId: string;
  contentType: string;
  title: string;
  size: number;
  durationMs: number | null;
  /** A recording's timeline (Figma 13): each step's offset and the agent's own description. */
  steps?: { atMs: number; label: string }[];
}

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
  ...(c.kind && c.kind !== 'repository' ? { kind: c.kind } : {}),
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
  // GitHub tokens (including ghs_<id>_<JWT>) and JWTs, whole: the same patterns as persisted run output.
  return maskCredentials(value, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]")
    .replace(
      /\b(?:sk-[\w-]+|mka_[\w]+|mkr_[\w]+)\b/g,
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
  let capture: FactoryCaptureEvidence | undefined;
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
  } else if (
    (ref.kind === "screenshot" || ref.kind === "video") &&
    CAPTURE_ARTIFACT.test(ref.artifact)
  ) {
    // Screenshots and recordings are the run's own captures (run_captures),
    // never a second copy and never a URL.
    const {
      rows: [row],
    } = await tx.query(
      `SELECT id,kind,"contentType",title,size,"durationMs","updatedAt" FROM run_captures
        WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND status='ready' FOR SHARE`,
      [ref.artifact.slice(CAPTURE_PREFIX.length), run.id, task.userId],
    );
    if (!row)
      throw new FactoryError("factoryArtifactMissing");
    if (row.kind !== (ref.kind === "screenshot" ? "image" : "video"))
      throw new FactoryError("factoryEvidenceMismatch");
    capture = {
      captureId: row.id as string,
      contentType: row.contentType as string,
      title: row.title as string,
      size: (row.size as number | null) ?? 0,
      durationMs: (row.durationMs as number | null) ?? null,
    };
    raw = { ...capture };
    if (row.kind === "video") {
      const { rows: steps } = await tx.query(
        `SELECT "atMs",label FROM run_capture_steps WHERE "captureId"=$1 AND "userId"=$2 ORDER BY "atMs","createdAt" LIMIT 200`,
        [row.id, task.userId],
      );
      capture.steps = steps.map((step) => ({ atMs: step.atMs as number, label: step.label as string }));
    }
    sourceTime = row.updatedAt;
  } else {
    // Only existing, access controlled artifacts. Arbitrary URLs never count.
    throw new FactoryError("factoryArtifactMissing");
  }
  if (new Date(ref.recordedAt).getTime() < sourceTime.getTime())
    throw new FactoryError("factoryEvidenceMismatch");
  return {
    raw,
    capture,
    sourceTime: sourceTime.toISOString(),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
  };
}

const CAPTURE_PREFIX = "run-capture:";
const CAPTURE_ARTIFACT = /^run-capture:[a-f0-9-]{36}$/;
export const captureArtifact = (id: string) => `${CAPTURE_PREFIX}${id}`;
export const captureIdOf = (artifact: string) =>
  CAPTURE_ARTIFACT.test(artifact) ? artifact.slice(CAPTURE_PREFIX.length) : null;

/** Evidence entries are capped per finish (contract.ts). */
const MAX_EVIDENCE = 100;

/**
 * The run's ready screenshots and recordings as evidence references next to
 * `base` (its report), oldest first. Trusted reconcilers call this; an agent
 * cannot name a capture of another run.
 */
export async function runCaptureEvidence(
  tx: PoolClient,
  run: { id: string; userId: string },
  base: FactoryEvidence,
  room = MAX_EVIDENCE - 1,
): Promise<FactoryEvidence[]> {
  if (room <= 0) return [];
  const { rows } = await tx.query(
    `SELECT id,kind,"updatedAt" FROM run_captures WHERE "runId"=$1 AND "userId"=$2 AND status='ready' ORDER BY "createdAt",id LIMIT $3`,
    [run.id, run.userId, room],
  );
  return rows.map((row) => ({
    ...base,
    artifact: captureArtifact(row.id),
    kind: row.kind === "video" ? "video" : "screenshot",
    recordedAt: new Date(
      Math.max(new Date(base.recordedAt).getTime(), row.updatedAt.getTime()),
    ).toISOString(),
  }));
}

/** An owner-consumed completion has its own immutable receipt. The old blocked
 * attempt stays blocked; only its canonical completed-run evidence is projected. */
async function recoveredExecutionEvidence(tx: PoolClient, task: FactoryTask, candidate: FactoryCandidate & { runId: string }) {
  const { rows } = await tx.query(`SELECT a.id,a.stage,a.status,r.id AS "runId",r."sessionId",
      completion.request->'change'->'evidence' AS evidence,receipt."eventId" AS "completionRecoveryEventId",completion."eventId" AS "completionEventId",
      receipt.request->'input'->'binding'->'revision' AS "ownerRevision",completion.request->'binding'->'revision' AS "completionRevision"
    FROM factory_tasks t JOIN factory_candidates c ON c."taskId"=t.id AND c.id=t."candidateId"
    JOIN agent_runs r ON r.id=c."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN factory_attempts a ON a."taskId"=t.id AND a."runId"=r.id AND a.stage='execute'
    JOIN factory_events receipt ON receipt."taskId"=t.id AND receipt.request->>'kind'='owner_completion_recovery'
    JOIN factory_events completion ON completion."taskId"=t.id AND completion."eventId"=$4
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND c.id=$5 AND r.id=$6
      AND a.status='blocked' AND a."candidateId" IS NULL AND a.output->'watchdog'->>'reasonCode'='recovery_exhausted'
      AND COALESCE(a.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
      AND a.output->'watchdog'->>'requestEpoch'=t."sourceEventId"::text
      AND r.status='succeeded' AND r."stopReason"='submitted' AND r."stopRequestedAt" IS NULL AND r."sessionId" IS NOT NULL
      AND receipt.request->>'sourceEventId'=t."sourceEventId"::text AND receipt.request->>'attemptId'=a.id::text AND receipt.request->>'runId'=r.id::text
      AND receipt.request#>>'{input,binding,taskId}'=t.id::text AND receipt.request#>>'{input,change,action}'='retry'
      AND receipt.result#>>'{task,id}'=t.id::text AND receipt.result#>>'{task,userId}'=t."userId" AND receipt.result#>>'{task,issueId}'=t."issueId"::text
      AND receipt.result#>>'{task,sourceEventId}'=t."sourceEventId"::text AND receipt.result#>>'{task,candidateId}'=c.id::text
      AND receipt.result#>>'{task,stage}'='review' AND receipt.result#>>'{task,status}' IN ('pending','running')
      AND completion.request#>>'{binding,taskId}'=t.id::text AND completion.request#>>'{change,action}'='finish'
      AND completion.request#>>'{change,status}'='passed' AND completion.request#>>'{change,output,runId}'=r.id::text
      AND completion.result#>>'{task,id}'=t.id::text AND completion.result#>>'{task,userId}'=t."userId" AND completion.result#>>'{task,issueId}'=t."issueId"::text
      AND completion.result#>>'{task,sourceEventId}'=t."sourceEventId"::text AND completion.result#>>'{task,candidateId}'=c.id::text
      AND completion.result#>>'{task,attemptId}'=a.id::text AND completion.result#>>'{task,stage}'='execute' AND completion.result#>>'{task,status}'='passed'`,
    [task.id, task.userId, task.issueId, factoryEventId('run-completion', candidate.runId), candidate.id, candidate.runId]);
  const row = rows[0];
  if (rows.length !== 1 || !Number.isInteger(row.ownerRevision) || row.ownerRevision < 1 ||
    row.completionRevision !== row.ownerRevision + 1 || !Array.isArray(row.evidence)) return null;
  return row;
}

export async function approvalEvidence(tx: PoolClient, task: FactoryTask) {
  const {
    rows: [candidate],
  } = await tx.query<FactoryCandidate & { runId: string }>(
    'SELECT * FROM factory_candidates WHERE id=$1 AND "taskId"=$2',
    [task.candidateId, task.id],
  );
  if (!candidate) throw new FactoryError("factoryEvidenceRequired");
  const { rows } = await tx.query(
    "SELECT * FROM factory_attempts WHERE \"taskId\"=$1 AND \"candidateId\"=$2 AND stage IN ('execute','review','verify') ORDER BY position",
    [task.id, candidate.id],
  );
  const latest = ["execute", "review", "verify"].map((stage) =>
    rows.filter((a) => a.stage === stage).at(-1),
  );
  const recovered = latest[0] ? null : await recoveredExecutionEvidence(tx, task, candidate);
  if (recovered) latest[0] = recovered;
  if (
    latest.some(
      (a) => !a || (a.status !== "passed" && a !== recovered) || !a.runId || !a.sessionId,
    ) ||
    new Set(latest.map((a) => a?.runId)).size !== 3 ||
    new Set(latest.map((a) => a?.sessionId)).size !== 3
  )
    throw new FactoryError("factoryIndependentEvidenceRequired");
  const artifacts = [];
  // Screenshots and recordings, shown to the reviewer. Approval binds the
  // candidate commit (a new commit voids it); like Factory.ai, Warp, Devin
  // and Codex, it does not bind capture files, so these stay out of the
  // manifest the evidence digest covers.
  const captures = [];
  const shown = [];
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
          (candidate.kind === 'report'
            ? run.report?.sourceCommit !== candidate.sha
            : candidate.kind === 'deliverable'
              ? candidate.sha !== null
              : !repositoryExecutionMatches(run.report,candidate.sha))
        )
          throw new FactoryError("factoryEvidenceMismatch");
      }
      const { raw, capture, ...timestamps } = source;
      // `sha256` is the digest of the record read back, as for every entry;
      // for a capture that is its metadata, never the file.
      const entry = {
        stage: attempt.stage,
        attemptId: attempt.id,
        ...(attempt === recovered ? { completionRecoveryEventId: recovered.completionRecoveryEventId, completionEventId: recovered.completionEventId } : {}),
        ...ref,
        ...timestamps,
        sha256: digest(raw),
      };
      if (capture) {
        const shownCapture = { ...entry, ...capture };
        captures.push(shownCapture);
        shown.push(shownCapture);
        continue;
      }
      artifacts.push(entry);
      shown.push(entry);
    }
  }
  const manifest = {
    candidateId: candidate.id,
    candidate: candidateIdentity(candidate),
    artifacts,
  };
  return {
    manifest,
    evidenceDigest: digest(manifest),
    /** What the reviewer sees: the manifest's entries plus the run-capture ones, in order. */
    view: { ...manifest, artifacts: shown },
    captures,
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
