import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import {
  CAPTURE_EXTENSIONS, CAPTURE_MAX_BYTES, captureKind, captureProblem, cleanCaptureTitle, sniffCaptureType,
  type CaptureContentType, type CaptureSource, type CaptureUploadRequest, type CaptureUploadResponse, type CaptureView,
} from '@mikka/protocol/capture'
import { withAccountWrite } from '@/lib/account/write-guard'
import { db } from '@/lib/db'
import { agentRuns, artifacts, runCaptureShares, runCaptures } from '@/lib/db/schema'
import { artifactStorage, deleteArtifactObject, getArtifactObjectBytes, presignArtifactPut, putArtifactObject } from '@/lib/artifacts/storage'

// Screenshots and screen recordings in Neon (whose, which run, share links)
// with their files in the artifacts bucket. Every read is scoped to the run's
// owner, or to a live share token; teammates never see a thread's captures
// (R-62), only what the thread hands over.

/** The run a capture belongs to. Callers resolve it from a run token, a device or a binding, never from input. */
export interface CaptureOwner { userId: string; runId: string; issueId: string | null; botId: string | null }

export type CaptureError = { error: 'invalid' | 'too_large' | 'not_found' | 'conflict' | 'unavailable'; message: string }

/** How long an announced upload may take before its slot is dropped. */
const UPLOAD_TTL_MS = 15 * 60_000
/** Uploads a run may have open at once. */
const MAX_OPEN_UPLOADS = 10
/** The server receives the bytes itself only without a bucket (previews, tests), below the platform's request limit. */
export const INLINE_UPLOAD_MAX_BYTES = 4_000_000

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const storageKey = (owner: CaptureOwner, id: string, contentType: CaptureContentType) => `${owner.userId}/runs/${owner.runId}/captures/${id}.${CAPTURE_EXTENSIONS[contentType]}`

type Row = typeof runCaptures.$inferSelect

export function captureView(row: Pick<Row, 'id' | 'kind' | 'contentType' | 'title' | 'size' | 'durationMs' | 'source' | 'createdAt'>): CaptureView {
  return { id: row.id, kind: row.kind, contentType: row.contentType, title: row.title, size: row.size ?? 0, durationMs: row.durationMs ?? null, source: row.source, createdAt: row.createdAt.toISOString() }
}

/** Puts checked bytes where files go and returns the columns that point at them. */
async function place(owner: CaptureOwner, id: string, bytes: Uint8Array, contentType: CaptureContentType) {
  const key = storageKey(owner, id, contentType)
  const storage = artifactStorage()
  // The file goes up before the row says ready, so a ready row never points at a missing object.
  if (storage === 'r2') await putArtifactObject(key, bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes), contentType)
  return { storageKey: key, inlineContent: storage === 'inline' ? Buffer.from(bytes) : null, size: bytes.length, sha256: sha256(bytes) }
}

/** Stores a finished file as a ready capture of the run. */
export async function saveCapture(owner: CaptureOwner, input: { bytes: Uint8Array; title: string; source: CaptureSource; durationMs?: number }): Promise<CaptureView | CaptureError> {
  return withAccountWrite(owner.userId, () => writableSaveCapture(owner, input))
}

async function writableSaveCapture(owner: CaptureOwner, input: { bytes: Uint8Array; title: string; source: CaptureSource; durationMs?: number }): Promise<CaptureView | CaptureError> {
  const contentType = sniffCaptureType(input.bytes)
  const problem = captureProblem(input.bytes)
  if (!contentType || problem) return { error: contentType ? 'too_large' : 'invalid', message: problem ?? 'Not a capture.' }
  const title = cleanCaptureTitle(input.title)
  if (!title) return { error: 'invalid', message: 'A title is required.' }
  const id = crypto.randomUUID()
  const file = await place(owner, id, input.bytes, contentType)
  const [row] = await db.insert(runCaptures).values({
    id, userId: owner.userId, runId: owner.runId, issueId: owner.issueId, botId: owner.botId,
    kind: captureKind(contentType), contentType, source: input.source, status: 'ready', title, durationMs: input.durationMs ?? null, ...file,
  }).returning()
  return captureView(row)
}

// --- Daemon uploads -----------------------------------------------------------

/** Drops the run's announced uploads that never completed, and their objects. */
async function dropStaleUploads(owner: CaptureOwner) {
  const stale = await db.update(runCaptures).set({ status: 'failed', error: 'Upload not completed in time', inlineContent: null, updatedAt: new Date() })
    .where(and(eq(runCaptures.runId, owner.runId), eq(runCaptures.userId, owner.userId), eq(runCaptures.status, 'uploading'), lt(runCaptures.expiresAt, new Date())))
    .returning({ storageKey: runCaptures.storageKey })
  if (artifactStorage() === 'r2') for (const row of stale) if (row.storageKey) await deleteArtifactObject(row.storageKey).catch(() => undefined)
}

/** Reserves a capture for a file the daemon is about to send and says where to send it. */
export async function beginUpload(owner: CaptureOwner, input: CaptureUploadRequest): Promise<CaptureUploadResponse | CaptureError> {
  return withAccountWrite(owner.userId, () => writableBeginUpload(owner, input))
}

async function writableBeginUpload(owner: CaptureOwner, input: CaptureUploadRequest): Promise<CaptureUploadResponse | CaptureError> {
  const kind = captureKind(input.contentType)
  if (input.size > CAPTURE_MAX_BYTES[kind]) return { error: 'too_large', message: `At most ${CAPTURE_MAX_BYTES[kind]} bytes for a ${kind}.` }
  const storage = artifactStorage()
  if (storage === 'inline' && input.size > INLINE_UPLOAD_MAX_BYTES) return { error: 'too_large', message: `At most ${INLINE_UPLOAD_MAX_BYTES} bytes without object storage.` }
  const title = cleanCaptureTitle(input.title)
  if (!title) return { error: 'invalid', message: 'A title is required.' }
  await dropStaleUploads(owner)
  const id = input.captureId ?? crypto.randomUUID()
  // Keep untrusted uploads separate from the immutable evidence namespace so
  // a bucket lifecycle rule can expire even a replayed presigned upload.
  const key = `capture-uploads/${storageKey(owner, id, input.contentType)}`
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS)
  const reserved = await db.transaction(async tx => {
    // Serialize reservation with the run's terminal transition. The route's
    // initial authentication alone cannot prevent a begin/end race.
    const [run] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(
      eq(agentRuns.id, owner.runId), eq(agentRuns.userId, owner.userId),
      inArray(agentRuns.status, ['preparing', 'running', 'waiting_input', 'finishing']), isNull(agentRuns.stopRequestedAt),
    )).for('update')
    if (!run) return 'not_found' as const
    const [{ open }] = await tx.select({ open: sql<number>`count(*)::int` }).from(runCaptures)
      .where(and(eq(runCaptures.runId, owner.runId), eq(runCaptures.status, 'uploading')))
    if (open >= MAX_OPEN_UPLOADS) return 'conflict' as const
    const inserted = await tx.insert(runCaptures).values({
      id, userId: owner.userId, runId: owner.runId, issueId: owner.issueId, botId: owner.botId,
      kind, contentType: input.contentType, source: 'local', status: 'uploading', title,
      storageKey: key, size: input.size, sha256: input.sha256, expiresAt,
    }).onConflictDoNothing().returning({ id: runCaptures.id })
    if (!inserted.length) return 'conflict' as const
    return null
  })
  if (reserved) return { error: reserved, message: reserved === 'conflict' ? 'Too many uploads in progress for this run.' : 'Run is no longer accepting uploads.' }
  if (storage === 'inline') return { captureId: id, upload: { target: 'server' } }
  const seconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  if (seconds < 1) return { error: 'unavailable', message: 'Upload expired.' }
  const signed = await presignArtifactPut(key, input.contentType, seconds)
  return { captureId: id, upload: { target: 'storage', ...signed } }
}

async function openUpload(owner: CaptureOwner, captureId: string) {
  const [row] = await db.select().from(runCaptures).where(and(
    eq(runCaptures.id, captureId), eq(runCaptures.runId, owner.runId), eq(runCaptures.userId, owner.userId), eq(runCaptures.status, 'uploading'),
  )).limit(1)
  return row && row.expiresAt && row.expiresAt.getTime() > Date.now() ? row : null
}

/** Reissue a target only for the same already-reserved, unexpired upload. */
export async function resumeUpload(owner: CaptureOwner, captureId: string): Promise<CaptureUploadResponse | CaptureError> {
  return withAccountWrite(owner.userId, () => writableResumeUpload(owner, captureId))
}

async function writableResumeUpload(owner: CaptureOwner, captureId: string): Promise<CaptureUploadResponse | CaptureError> {
  const row = await openUpload(owner, captureId)
  if (!row || row.source !== 'local' || !row.storageKey || !row.expiresAt) return { error: 'not_found', message: 'No open upload with that id for this run.' }
  if (artifactStorage() === 'inline') return { captureId, upload: { target: 'server' } }
  const seconds = Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)
  if (seconds < 1) return { error: 'not_found', message: 'Upload expired.' }
  return { captureId, upload: { target: 'storage', ...await presignArtifactPut(row.storageKey, row.contentType, seconds) } }
}

/** The bytes of an upload sent to the server (no bucket configured). */
export async function receiveUpload(owner: CaptureOwner, captureId: string, bytes: Uint8Array): Promise<{ ok: true } | CaptureError> {
  if (artifactStorage() !== 'inline') return { error: 'conflict', message: 'Send the file to the upload URL instead.' }
  const row = await openUpload(owner, captureId)
  if (!row) return { error: 'not_found', message: 'No open upload with that id for this run.' }
  if (bytes.length !== row.size) return { error: 'invalid', message: `Expected ${row.size} bytes.` }
  const updated = await db.update(runCaptures).set({ inlineContent: Buffer.from(bytes), updatedAt: new Date() })
    .where(and(eq(runCaptures.id, row.id), eq(runCaptures.status, 'uploading'))).returning({ id: runCaptures.id })
  return updated.length ? { ok: true } : { error: 'conflict', message: 'The upload already ended.' }
}

/**
 * Checks what arrived against what was announced (size, hash, the type the
 * bytes show, the limit) and only then makes it a capture. A file that fails
 * is deleted.
 */
export async function completeUpload(owner: CaptureOwner, captureId: string): Promise<CaptureView | CaptureError> {
  return withAccountWrite(owner.userId, () => writableCompleteUpload(owner, captureId))
}

async function writableCompleteUpload(owner: CaptureOwner, captureId: string): Promise<CaptureView | CaptureError> {
  // A lost success response is safe to retry for the original upload window.
  const readyUpload = async () => (await db.select().from(runCaptures).where(and(
    eq(runCaptures.id, captureId), eq(runCaptures.runId, owner.runId), eq(runCaptures.userId, owner.userId),
    eq(runCaptures.source, 'local'), eq(runCaptures.status, 'ready'), sql`${runCaptures.expiresAt} > now()`,
  )).limit(1))[0]
  const completed = await readyUpload()
  if (completed) return captureView(completed)
  const row = await openUpload(owner, captureId)
  if (!row || !row.storageKey) {
    const winner = await readyUpload()
    return winner ? captureView(winner) : { error: 'not_found', message: 'No open upload with that id for this run.' }
  }
  const storage = artifactStorage()
  const bytes = row.inlineContent ? new Uint8Array(row.inlineContent)
    : storage === 'r2' ? await getArtifactObjectBytes(row.storageKey).catch(() => null) : null
  if (!bytes) return { error: 'not_found', message: 'The file has not arrived.' }
  const problem = bytes.length !== row.size ? `Expected ${row.size} bytes, got ${bytes.length}.`
    : sha256(bytes) !== row.sha256 ? 'The file does not match its sha256.'
      : captureProblem(bytes, row.contentType)
  if (problem) {
    const failed = await db.update(runCaptures).set({ status: 'failed', error: problem, inlineContent: null, updatedAt: new Date() })
      .where(and(eq(runCaptures.id, row.id), eq(runCaptures.status, 'uploading'))).returning({ id: runCaptures.id })
    if (storage === 'r2' && failed.length) await deleteArtifactObject(row.storageKey).catch(() => undefined)
    if (!failed.length) {
      const winner = await readyUpload()
      if (winner) return captureView(winner)
    }
    return { error: 'invalid', message: problem }
  }
  // A presigned PUT remains usable until expiry. Publish the verified bytes
  // under a fresh key the uploader cannot overwrite; also persist the exact
  // checked bytes for inline uploads in case a second PUT races completion.
  const verifiedKey = storage === 'r2' ? storageKey(owner, crypto.randomUUID(), row.contentType) : row.storageKey
  if (storage === 'r2') await putArtifactObject(verifiedKey, new Uint8Array(bytes), row.contentType)
  const [ready] = await db.update(runCaptures).set({ status: 'ready', storageKey: verifiedKey, inlineContent: storage === 'inline' ? Buffer.from(bytes) : null, updatedAt: new Date() })
    .where(and(eq(runCaptures.id, row.id), eq(runCaptures.status, 'uploading'))).returning()
  if (storage === 'r2') {
    // The upload URL may still recreate its staging object until it expires.
    // Its eventual cleanup requires an object-storage lifecycle rule.
    await deleteArtifactObject(ready ? row.storageKey : verifiedKey).catch(() => undefined)
  }
  if (ready) return captureView(ready)
  const winner = await readyUpload()
  return winner ? captureView(winner) : { error: 'conflict', message: 'The upload already ended.' }
}

// --- Cloud computer recordings --------------------------------------------------

/** Reserves the run's one recording slot; null when one is already going. */
export async function openRecording(owner: CaptureOwner, input: { title: string; display: number; stopsAt: Date }): Promise<{ id: string } | null> {
  const id = crypto.randomUUID()
  const inserted = await db.insert(runCaptures).values({
    id, userId: owner.userId, runId: owner.runId, issueId: owner.issueId, botId: owner.botId,
    kind: 'video', contentType: 'video/mp4', source: 'cloud_computer', status: 'recording',
    title: cleanCaptureTitle(input.title) || 'Recording', display: input.display, expiresAt: input.stopsAt,
  }).onConflictDoNothing().returning({ id: runCaptures.id })
  return inserted[0] ?? null
}

/** The run's recording in progress, if any. */
export async function currentRecording(runId: string) {
  const [row] = await db.select().from(runCaptures).where(and(eq(runCaptures.runId, runId), eq(runCaptures.status, 'recording'))).limit(1)
  return row ?? null
}

export async function finishRecording(row: Row, input: { bytes: Uint8Array; durationMs: number }): Promise<CaptureView | CaptureError> {
  return withAccountWrite(row.userId, () => writableFinishRecording(row, input))
}

async function writableFinishRecording(row: Row, input: { bytes: Uint8Array; durationMs: number }): Promise<CaptureView | CaptureError> {
  const problem = captureProblem(input.bytes, 'video/mp4')
  if (problem) { await failRecording(row.id, problem); return { error: 'invalid', message: problem } }
  const file = await place(row, row.id, input.bytes, 'video/mp4')
  const [ready] = await db.update(runCaptures).set({ status: 'ready', ...file, durationMs: input.durationMs, expiresAt: null, updatedAt: new Date() })
    .where(and(eq(runCaptures.id, row.id), eq(runCaptures.status, 'recording'))).returning()
  return ready ? captureView(ready) : { error: 'conflict', message: 'The recording already ended.' }
}

export async function failRecording(id: string, error: string) {
  await db.update(runCaptures).set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(runCaptures.id, id), eq(runCaptures.status, 'recording')))
}

// --- Reads ----------------------------------------------------------------------

/**
 * What a run produced, for the acceptance view: its ready captures and the
 * documents it handed over, oldest first. Null when the run is not the
 * person's own.
 */
export async function runEvidence(userId: string, runId: string) {
  const [run] = await db.select({ id: agentRuns.id, status: agentRuns.status, issueId: agentRuns.issueId, botId: agentRuns.botId })
    .from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId))).limit(1)
  if (!run) return null
  const captures = await db.select().from(runCaptures)
    .where(and(eq(runCaptures.runId, runId), eq(runCaptures.userId, userId), eq(runCaptures.status, 'ready'))).orderBy(asc(runCaptures.createdAt))
  const documents = await db.select({ id: artifacts.id, kind: artifacts.kind, title: artifacts.title, latestVersion: artifacts.latestVersion, createdAt: artifacts.createdAt })
    .from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.userId, userId))).orderBy(asc(artifacts.createdAt))
  const recording = await db.select({ id: runCaptures.id }).from(runCaptures)
    .where(and(eq(runCaptures.runId, runId), eq(runCaptures.userId, userId), eq(runCaptures.status, 'recording'))).limit(1)
  return {
    run,
    recording: recording.length > 0,
    captures: captures.map(captureView),
    artifacts: documents.map(document => ({ ...document, createdAt: document.createdAt.toISOString() })),
  }
}

async function fileOf(row: Pick<Row, 'storageKey' | 'inlineContent'>): Promise<Uint8Array<ArrayBuffer> | null> {
  if (row.inlineContent) return new Uint8Array(row.inlineContent)
  return row.storageKey ? await getArtifactObjectBytes(row.storageKey) : null
}

/** The person's ready capture with its bytes. */
export async function readCapture(userId: string, captureId: string) {
  const [row] = await db.select().from(runCaptures)
    .where(and(eq(runCaptures.id, captureId), eq(runCaptures.userId, userId), eq(runCaptures.status, 'ready'))).limit(1)
  if (!row) return null
  const bytes = await fileOf(row)
  return bytes ? { ...captureView(row), bytes } : null
}

// --- Share links, as artifact shares ----------------------------------------------

const SHARE_PREFIX = 'mkc_'
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** A new link anyone can open; returns the token once. */
export async function createCaptureShare(userId: string, captureId: string): Promise<{ token: string } | null> {
  const [row] = await db.select({ id: runCaptures.id }).from(runCaptures)
    .where(and(eq(runCaptures.id, captureId), eq(runCaptures.userId, userId), eq(runCaptures.status, 'ready'))).limit(1)
  if (!row) return null
  const token = `${SHARE_PREFIX}${randomBytes(24).toString('base64url')}`
  await db.insert(runCaptureShares).values({ id: crypto.randomUUID(), captureId, tokenHash: hashToken(token), createdBy: userId })
  return { token }
}

/** Ends every live link to the capture. */
export async function revokeCaptureShares(userId: string, captureId: string): Promise<number> {
  const revoked = await db.update(runCaptureShares).set({ revokedAt: new Date() })
    .where(and(eq(runCaptureShares.captureId, captureId), isNull(runCaptureShares.revokedAt), sql`exists (select 1 from ${runCaptures} where ${runCaptures.id} = ${runCaptureShares.captureId} and ${runCaptures.userId} = ${userId})`))
    .returning({ id: runCaptureShares.id })
  return revoked.length
}

/** The capture a live share token opens. */
export async function sharedCapture(token: string) {
  if (!token.startsWith(SHARE_PREFIX)) return null
  const [share] = await db.select({ captureId: runCaptureShares.captureId }).from(runCaptureShares)
    .where(and(eq(runCaptureShares.tokenHash, hashToken(token)), isNull(runCaptureShares.revokedAt))).limit(1)
  if (!share) return null
  const [row] = await db.select().from(runCaptures).where(and(eq(runCaptures.id, share.captureId), eq(runCaptures.status, 'ready'))).limit(1)
  if (!row) return null
  const bytes = await fileOf(row)
  return bytes ? { ...captureView(row), bytes } : null
}

/** Ids of the run's recordings still going, for cleanup when the run ends. */
export async function runRecordings(runIds: readonly string[]) {
  if (!runIds.length) return []
  return db.select().from(runCaptures).where(and(inArray(runCaptures.runId, [...runIds]), eq(runCaptures.status, 'recording')))
}
