import { factoryFlowVersion } from './contract'
import { repositoryExecutionMatches } from './execution-receipt'
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { CAPTURE_MAX_BYTES } from '@mikka/protocol/capture';
import {
  evidenceSchema,
  FactoryError,
  type FactoryEvidence,
} from "./approval-contract";
import type { FactoryApprovalStore, FactoryCandidate, FactoryTask } from "./approval-dependencies";
import { maskCredentials } from "../secrets/mask";
import { completedRecoveryEvidence, readDeliverableSnapshotReceipt } from './deliverable-snapshot';

export const FACTORY_VISUAL_EVIDENCE_REQUIRED = 'factory_visual_evidence_required';
export const FACTORY_PUBLIC_EVIDENCE_REQUIRED = 'factory_public_evidence_required';
export const factoryEvidenceBlockReason = (code: string) => code === FACTORY_PUBLIC_EVIDENCE_REQUIRED
  ? 'The current candidate PR must contain confirmed public links to its checked visual evidence before handoff.'
  : 'The current implementation run has no ready screenshot or recording. Record the running application, test or API result, or rendered documentation before handoff.';

/** The producer's stored media, never a reviewer capture, text claim or an old
 * candidate's evidence. Upload completion owns byte validation and storage. */
export async function hasFactoryVisualEvidence(tx: PoolClient, task: Pick<FactoryTask, 'id' | 'userId' | 'issueId' | 'candidateId'>,
  /** Only the store's private completed-run recovery authority supplies this,
   * before its immutable owner receipt is written in the same transaction. */
  completedProducer?: { runId: string; sessionId: string }): Promise<boolean> {
  if (!task.candidateId) return false;
  const { rows: [producer] } = await tx.query(`SELECT c.*,r.report,r."sessionId",
      EXISTS (SELECT 1 FROM factory_attempts a WHERE a."taskId"=c."taskId" AND a."runId"=r.id
        AND a.stage='execute' AND a."sessionId"=r."sessionId") AS "sessionMatches"
    FROM factory_candidates c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=$3 AND r."issueId"=$4
    WHERE c.id=$1 AND c."taskId"=$2 AND r.status='succeeded' AND r."stopReason"='submitted'
      AND r."stopRequestedAt" IS NULL AND r."sessionId" IS NOT NULL AND r."sessionId"<>''
      AND r."startedAt" IS NOT NULL AND r."finishedAt" IS NOT NULL
      AND EXISTS (SELECT 1 FROM factory_attempts a WHERE a."taskId"=c."taskId" AND a."runId"=r.id AND a.stage='execute') FOR SHARE OF c,r`,
  [task.candidateId, task.id, task.userId, task.issueId]);
  if (!producer || (producer.kind === 'report'
    ? !/^[a-f0-9]{40}$/.test(producer.sha ?? '') || producer.report?.sourceCommit !== producer.sha
    : producer.kind === 'deliverable'
      ? producer.sha !== null || !/^[a-f0-9]{40}$/.test(producer.report?.sourceCommit ?? '')
      : !repositoryExecutionMatches(producer.report, producer.sha))) return false;
  if (!producer.sessionMatches && !(completedProducer && completedProducer.runId === producer.runId && completedProducer.sessionId === producer.sessionId)) {
    const recovered = await recoveredExecutionEvidence(tx, task, producer);
    if (!recovered || recovered.sessionId !== producer.sessionId) return false;
  }
  const { rowCount } = await tx.query(`SELECT id FROM run_captures WHERE "runId"=$1 AND "userId"=$2 AND status='ready'
    AND ("issueId" IS NULL OR "issueId"=$5)
    AND ((kind='image' AND "contentType" IN ('image/png','image/jpeg','image/webp') AND size BETWEEN 1 AND $3)
      OR (kind='video' AND "contentType" IN ('video/mp4','video/webm') AND size BETWEEN 1 AND $4))
    AND sha256 ~ '^[a-f0-9]{64}$' AND (NULLIF("storageKey",'') IS NOT NULL OR octet_length("inlineContent")=size)
    LIMIT 1 FOR SHARE`, [producer.runId, task.userId, CAPTURE_MAX_BYTES.image, CAPTURE_MAX_BYTES.video, task.issueId]);
  return rowCount === 1;
}

export async function requireFactoryVisualEvidence(tx: PoolClient, task: Pick<FactoryTask, 'id' | 'userId' | 'issueId' | 'candidateId'>): Promise<void> {
  if (!await hasFactoryVisualEvidence(tx, task)) throw new FactoryError(FACTORY_VISUAL_EVIDENCE_REQUIRED);
}

/** A refusal is returned so the caller can commit the blocked state. Other
 * failures still throw and roll back the whole transaction. */
export async function factoryHandoffEvidenceError(tx: PoolClient, task: FactoryTask,
  completedProducer?: { runId: string; sessionId: string }): Promise<FactoryError | null> {
  if (!await hasFactoryVisualEvidence(tx, task, completedProducer)) return new FactoryError(FACTORY_VISUAL_EVIDENCE_REQUIRED);
  const { assertFactoryPublicationEvidence } = await import('../captures/publication');
  try { await assertFactoryPublicationEvidence(tx, task); }
  catch (error) {
    if ((error as { code?: string } | null)?.code === FACTORY_PUBLIC_EVIDENCE_REQUIRED) return new FactoryError(FACTORY_PUBLIC_EVIDENCE_REQUIRED);
    throw error;
  }
  return null;
}

/** Direct approval/merge of an older pending task must use the same gate as
 * stage advancement. Return the error; throw it only after COMMIT. */
export async function blockFactoryApprovalWithoutEvidence(tx: PoolClient, task: FactoryTask, store: FactoryApprovalStore, eventId: string): Promise<FactoryError | null> {
  const error = await factoryHandoffEvidenceError(tx, task);
  if (!error) return null;
  await store.apply(task.userId, { taskId: task.id, revision: task.revision }, eventId, {
    action: 'finish', status: 'blocked', reason: factoryEvidenceBlockReason(error.code), evidence: [],
    output: { evidenceGate: { code: error.code, candidateId: task.candidateId } },
  }, tx);
  return error;
}

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
        WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND ("issueId" IS NULL OR "issueId"=$4) AND status='ready' FOR SHARE`,
      [ref.artifact.slice(CAPTURE_PREFIX.length), run.id, task.userId, task.issueId],
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
    `SELECT c.id,c.kind,c."updatedAt" FROM run_captures c
      JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
      WHERE c."runId"=$1 AND c."userId"=$2 AND (c."issueId" IS NULL OR c."issueId"=r."issueId") AND c.status='ready'
      ORDER BY c."createdAt",c.id LIMIT $3`,
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
async function recoveredExecutionEvidence(tx: PoolClient, task: Pick<FactoryTask,'id'|'userId'|'issueId'>, candidate: FactoryCandidate & { runId: string }) {
  const completed = await completedRecoveryEvidence(tx, task, candidate);
  if (completed || candidate.kind !== 'deliverable') return completed;
  const retained = await readDeliverableSnapshotReceipt(tx, task, candidate.id);
  if (!retained) return null;
  const original = retained.completion;
  const evidence = original.evidence.map((value: unknown) => {
    const parsed = evidenceSchema.safeParse(value);
    if (!parsed.success || parsed.data.candidateId !== retained.previous.id || parsed.data.sha !== null ||
      parsed.data.environment !== retained.previous.environment || parsed.data.runId !== original.runId ||
      parsed.data.sessionId !== original.sessionId) throw new FactoryError('factoryEvidenceMismatch');
    // This is an explicit projection in the current manifest. The persisted
    // source receipt and original report remain byte-for-byte unchanged.
    return { ...parsed.data, candidateId: candidate.id };
  });
  return { ...original, evidence, deliverableSnapshotRecoveryEventId: retained.eventId,
    deliverableSnapshotReceiptDigest: retained.receiptDigest, originalEvidenceCandidateId: retained.previous.id,
    deliverableSnapshotSha: retained.snapshot.head, deliverableSnapshotTree: retained.snapshot.tree };
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
  const singleReview = factoryFlowVersion(task) === 2;
  // An earlier review is historical feedback on its original candidate. It is
  // shown separately and never becomes evidence that the repaired head passed.
  const history = singleReview ? (await tx.query(`SELECT a.id,a.status,a."candidateId",c.sha,a."runId",a."sessionId",a.reason,a.output,a.evidence
    FROM factory_attempts a JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
    WHERE a."taskId"=$1 AND a.stage='review' AND a."candidateId"<>$2 AND a."runId" IS NOT NULL
      AND a.status IN ('passed','failed','blocked','waiting') ORDER BY a.position`, [task.id, candidate.id])).rows : [];
  const currentReview = rows.filter(a => a.stage === 'review').at(-1);
  const stages = singleReview ? ['execute', ...(currentReview ? ['review'] : [])] : ['execute', 'review', 'verify'];
  if (singleReview && !currentReview && !history.length) throw new FactoryError('factoryIndependentEvidenceRequired');
  const latest = stages.map(stage => rows.filter(a => a.stage === stage).at(-1));
  const reviewHistory = history.map(a => ({
    attemptId: a.id, candidateId: a.candidateId, sha: a.sha, status: a.status,
    runId: a.runId, sessionId: a.sessionId, appliesToCurrentCandidate: false as const,
    reason: redactArtifact(a.reason), findings: redactArtifact(a.output?.completion?.findings ?? []),
    evidence: (a.evidence ?? []).flatMap((value: unknown) => {
      const ref = evidenceSchema.safeParse(value);
      return ref.success && ref.data.candidateId === a.candidateId && ref.data.sha === a.sha &&
        ref.data.runId === a.runId && ref.data.sessionId === a.sessionId ? [ref.data] : [];
    }),
  }));
  const recovered = latest[0] ? null : await recoveredExecutionEvidence(tx, task, candidate);
  if (recovered) latest[0] = recovered;
  if (
    latest.some(
      (a) => !a || (a.status !== "passed" && a !== recovered) || !a.runId || !a.sessionId,
    ) ||
    new Set(latest.map((a) => a?.runId)).size !== latest.length ||
    new Set(latest.map((a) => a?.sessionId)).size !== latest.length
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
        ...(attempt === recovered ? { completionRecoveryEventId: recovered.completionRecoveryEventId, completionEventId: recovered.completionEventId,
          ...(recovered.deliverableSnapshotRecoveryEventId ? { deliverableSnapshotRecoveryEventId: recovered.deliverableSnapshotRecoveryEventId,
            deliverableSnapshotReceiptDigest: recovered.deliverableSnapshotReceiptDigest, originalEvidenceCandidateId: recovered.originalEvidenceCandidateId,
            deliverableSnapshotSha: recovered.deliverableSnapshotSha, deliverableSnapshotTree: recovered.deliverableSnapshotTree } : {}) } : {}),
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
    ...(singleReview ? { reviewHistory } : {}),
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
