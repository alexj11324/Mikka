import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { CAPTURE_MAX_BYTES } from '@mikka/protocol/capture'
import { runVisualEvidence } from '@mikka/protocol/run'
import { withBasePath } from '../base-path'
import { factoryEventId } from '../factory/event-id'
import { completedRecoveryEvidence } from '../factory/deliverable-snapshot'
import { PublicationError } from '../run-publication-result'
import { publicationEvidenceDigest, publicCaptureToken, validPublicationEvidence, type PublicationEvidence, type PublicCapture } from './publication-contract'

type Query = Pick<PoolClient, 'query'>
type Identity = { userId: string; issueId: string; runId: string; sha: string }
type Current = Identity & { taskId: string; candidateId: string; visualEvidence: unknown }
type Capture = { id: string; kind: 'image' | 'video'; contentType: PublicCapture['contentType']; size: number; durationMs: number | null; sha256: string }
const rejected = (cause?: unknown) => {
  const error = new PublicationError('factory_public_evidence_required')
  if (cause !== undefined) error.cause = cause
  return error
}
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex')
const receiptId = (runId: string) => factoryEventId('pr-visual-evidence', runId)
const sameIdentity = (receipt: PublicationEvidence, current: Current) =>
  receipt.taskId === current.taskId && receipt.candidateId === current.candidateId
  && receipt.runId === current.runId && receipt.sha === current.sha
  && receipt.userId === current.userId && receipt.issueId === current.issueId

async function currentCandidate(tx: Query, identity: Identity, lock = false) {
  const { rows } = await tx.query<Current & { attemptCandidateId: string | null; attemptStatus: string }>(`SELECT t.id AS "taskId",c.id AS "candidateId",r.id AS "runId",c.sha,
      t."userId",t."issueId",r.report->'visualEvidence' AS "visualEvidence",a."candidateId" AS "attemptCandidateId",a.status AS "attemptStatus"
    FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
    JOIN agent_runs r ON r.id=c."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN factory_attempts a ON a."taskId"=t.id AND a."runId"=r.id AND a.stage='execute'
    WHERE t."userId"=$1 AND t."issueId"=$2 AND r.id=$3 AND c.sha=$4 AND c.kind='repository'
      AND t.status NOT IN ('revoked','cancelled') AND r.status='succeeded' AND r."stopReason"='submitted'
      AND r."stopRequestedAt" IS NULL
      AND COALESCE(a.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text ${lock ? 'FOR UPDATE OF t' : ''}`,
  [identity.userId, identity.issueId, identity.runId, identity.sha])
  if (rows.length !== 1) throw rejected()
  const row = rows[0]
  if (row.attemptCandidateId !== row.candidateId || row.attemptStatus !== 'passed') {
    // An owner can consume a completed producer after watchdog recovery. Its
    // original attempt intentionally remains blocked with no candidate; only
    // the existing immutable host receipt can establish that binding.
    const recovered = await completedRecoveryEvidence(tx,
      { id: row.taskId, userId: row.userId, issueId: row.issueId }, { id: row.candidateId, runId: row.runId })
    if (!recovered) throw rejected()
  }
  return row
}

async function validateReceipt(tx: Query, receipt: PublicationEvidence, current: Current, lock = false) {
  if (!sameIdentity(receipt, current)) throw rejected()
  const report = runVisualEvidence.safeParse(current.visualEvidence)
  const declared = report.success ? report.data : []
  if (declared.length !== receipt.captures.length || declared.some(ref => !receipt.captures.some(capture => capture.captureId === ref.captureId))) throw rejected()
  for (const capture of receipt.captures) {
    const token = publicCaptureToken(capture.url)
    if (!token) throw rejected()
    const { rows } = await tx.query(`SELECT c.id FROM run_captures c
      JOIN run_capture_shares s ON s."captureId"=c.id AND s."createdBy"=$3 AND s."tokenHash"=$4 AND s."revokedAt" IS NULL
      WHERE c.id=$1 AND c."runId"=$2 AND c."userId"=$3 AND c.status='ready' AND (c."issueId" IS NULL OR c."issueId"=$10)
        AND c.kind=$5 AND c."contentType"=$6 AND c.sha256=$7 AND c.size=$8
        AND c."durationMs" IS NOT DISTINCT FROM $9 ${lock ? 'FOR SHARE OF c,s' : ''}`,
    [capture.captureId, receipt.runId, receipt.userId, hashToken(token), capture.kind, capture.contentType, capture.sha256, capture.size, capture.durationMs, receipt.issueId])
    if (rows.length !== 1) throw rejected()
  }
}

/** Create the existing revocable shares once, after an explicit content review.
 * The host receipt survives an ambiguous GitHub write; a revoked share never
 * gets silently reissued by a retry. No capture bytes or new storage are made. */
export async function prepareFactoryPublicationEvidence(pool: Pick<Pool, 'connect'>, identity: Identity, origin: string | null | undefined): Promise<PublicationEvidence> {
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    await tx.query("SET LOCAL lock_timeout='5s'")
    const current = await currentCandidate(tx, identity, true)
    const { rows: [saved] } = await tx.query('SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [current.taskId, receiptId(identity.runId)])
    if (saved) {
      const receipt = validPublicationEvidence(saved.result)
      if (!receipt) throw rejected()
      await validateReceipt(tx, receipt, current, true)
      await tx.query('COMMIT')
      return receipt
    }
    const parsed = runVisualEvidence.safeParse(current.visualEvidence)
    const declarations = parsed.success ? parsed.data : []
    if (!origin || !declarations.length || new Set(declarations.map(ref => ref.captureId)).size !== declarations.length) throw rejected()
    const captureIds = declarations.map(ref => ref.captureId).sort()
    const { rows } = await tx.query<Capture>(`SELECT id,kind,"contentType",size,"durationMs",sha256 FROM run_captures
      WHERE id=ANY($1::uuid[]) AND "runId"=$2 AND "userId"=$3 AND ("issueId" IS NULL OR "issueId"=$4) AND status='ready' ORDER BY id FOR SHARE`,
    [captureIds, identity.runId, identity.userId, identity.issueId])
    if (rows.length !== captureIds.length) throw rejected()
    const captures: PublicCapture[] = []
    for (const row of rows) {
      if (!['image','video'].includes(row.kind) || !row.size || row.size > CAPTURE_MAX_BYTES[row.kind]
        || !/^[a-f0-9]{64}$/.test(row.sha256)) throw rejected()
      const token = `mkc_${randomBytes(24).toString('base64url')}`
      let url: string
      try { url = new URL(withBasePath(`/api/captures/shared/${token}`), origin).href }
      catch (error) { throw rejected(error) }
      if (!publicCaptureToken(url)) throw rejected()
      const capture: PublicCapture = { captureId: row.id, kind: row.kind, contentType: row.contentType,
        size: row.size, durationMs: row.durationMs, sha256: row.sha256, url }
      captures.push(capture)
      await tx.query(`INSERT INTO run_capture_shares(id,"captureId","tokenHash","createdBy") VALUES($1,$2,$3,$4)`,
        [randomUUID(), row.id, hashToken(token), identity.userId])
    }
    const unsigned = { version: 1 as const, taskId: current.taskId, candidateId: current.candidateId,
      runId: identity.runId, sha: identity.sha, userId: identity.userId, issueId: identity.issueId, captures }
    const receipt = validPublicationEvidence({ ...unsigned, digest: publicationEvidenceDigest(unsigned) })
    if (!receipt) throw rejected()
    await tx.query('INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)',
      [receipt.taskId, receiptId(identity.runId), JSON.stringify({ kind: 'pr_visual_evidence', ...identity, candidateId: receipt.candidateId }), JSON.stringify(receipt)])
    await tx.query('COMMIT')
    return receipt
  } catch (error) { await tx.query('ROLLBACK'); throw error }
  finally { tx.release() }
}

/** Hold capture/share revocation locks through the bounded GitHub mutation.
 * The caller separately holds current issue/run/publication authority. */
export async function lockFactoryPublicationEvidence(tx: Query, receipt: PublicationEvidence) {
  const current = await currentCandidate(tx, receipt)
  await validateReceipt(tx, receipt, current, true)
}

/** Standalone transaction boundary for callers without an authority client. */
export async function withFactoryPublicationEvidence<T>(pool: Pick<Pool, 'connect'>, receipt: PublicationEvidence, write: () => Promise<T>) {
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    await tx.query("SET LOCAL lock_timeout='5s'")
    await lockFactoryPublicationEvidence(tx, receipt)
    const result = await write()
    await tx.query('COMMIT')
    return result
  } catch (error) { await tx.query('ROLLBACK'); throw error }
  finally { tx.release() }
}

/** Only an acknowledged PR body with this exact receipt is ready to hand over. */
export async function factoryPublicationEvidenceReady(tx: Query, task: { id: string; userId: string; issueId: string; candidateId: string | null }) {
  const { rows: [row] } = await tx.query(`SELECT c.kind,c.sha,c."runId",p.status,p."pullRequest"->>'evidenceDigest' AS digest
    FROM factory_candidates c LEFT JOIN run_publications p ON p."runId"=c."runId" AND p."userId"=$3
    WHERE c."taskId"=$1 AND c.id=$2`, [task.id, task.candidateId, task.userId])
  if (!row) return false
  if (row.kind !== 'repository') return true
  // The event key is derived from the producer, never from an untrusted report URL.
  const { rows: [event] } = await tx.query('SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, receiptId(row.runId)])
  const receipt = validPublicationEvidence(event?.result)
  if (!receipt || row.status !== 'published' || row.digest !== receipt.digest) return false
  try {
    const current = await currentCandidate(tx, { userId: task.userId, issueId: task.issueId, runId: row.runId, sha: row.sha })
    if (current.taskId !== task.id || current.candidateId !== task.candidateId) return false
    await validateReceipt(tx, receipt, current)
    return true
  } catch (error) { if (error instanceof PublicationError) return false; throw error }
}

export async function assertFactoryPublicationEvidence(tx: Query, task: { id: string; userId: string; issueId: string; candidateId: string | null }) {
  if (!await factoryPublicationEvidenceReady(tx, task)) throw rejected()
}
