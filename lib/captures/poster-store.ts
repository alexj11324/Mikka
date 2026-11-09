import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { CaptureSource, CaptureView } from '@mikka/protocol/capture'
import { pool } from '../db'
import { artifactStorage, deleteArtifactObject, getArtifactObjectStream, putArtifactObject } from '../artifacts/storage'
import { CAPTURE_POSTER_MAX_BYTES, renderCapturePoster } from './poster'

interface Original {
  id: string; userId: string; runId: string; sha256: string; title: string; source: CaptureSource; createdAt: Date | string
  storageKey: string | null; inlineContent: Buffer | null
}
interface Poster { storageKey: string; inlineContent: Buffer | null; size: number; sha256: string }
export type CapturePosterFile = CaptureView & { bytes: Uint8Array<ArrayBuffer> }
export interface CapturePosterStorage {
  kind: () => 'r2' | 'inline'
  read: (key: string, signal: AbortSignal, maximum: number) => Promise<Uint8Array<ArrayBuffer>>
  write: (key: string, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<void>
  remove: (key: string) => Promise<void>
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const objectStorage: CapturePosterStorage = {
  kind: artifactStorage,
  async read(key, signal, maximum) {
    const reader = (await getArtifactObjectStream(key,signal)).getReader()
    const parts: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > maximum) throw new Error('capturePosterObjectTooLarge')
        parts.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let position = 0
    for (const part of parts) { bytes.set(part,position); position += part.length }
    return bytes
  },
  async write(key, bytes, signal) {
    signal.throwIfAborted()
    await putArtifactObject(key,bytes,'image/jpeg')
    signal.throwIfAborted()
  },
  remove: deleteArtifactObject,
}

/** Private, derived cache keyed by the immutable original digest. Legacy
 * recordings use the same path; GET never starts a VM or makes a share link. */
export function createCapturePosters(database: Pool, storage: CapturePosterStorage = objectStorage,
  render: typeof renderCapturePoster = renderCapturePoster) {
  const cached = async (owner: Original) => (await database.query<Poster>(`SELECT p."storageKey",p."inlineContent",p.size,p.sha256
    FROM run_capture_posters p JOIN run_captures c ON c.id=p."captureId" AND c.sha256=p."captureSha256"
    JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
    WHERE c.id=$1 AND c."userId"=$2 AND c."runId"=$3 AND c.sha256=$4 AND c.kind='video' AND c.status='ready'`,
  [owner.id,owner.userId,owner.runId,owner.sha256])).rows[0]
  const file = async (original: Original, poster: Poster, signal: AbortSignal): Promise<CapturePosterFile> => {
    const bytes = poster.inlineContent ? new Uint8Array(poster.inlineContent) : await storage.read(poster.storageKey,signal,CAPTURE_POSTER_MAX_BYTES)
    if (bytes.length !== poster.size || hash(bytes) !== poster.sha256) throw new Error('capturePosterIntegrityMismatch')
    return { id: original.id, kind: 'image', contentType: 'image/jpeg', source: original.source, title: original.title,
      durationMs: null, size: bytes.length, createdAt: new Date(original.createdAt).toISOString(), bytes }
  }
  return async (userId: string, captureId: string, callerSignal?: AbortSignal): Promise<CapturePosterFile | null> => {
    const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(callerSignal ? [callerSignal] : [])])
    const { rows: [original] } = await database.query<Original>(`SELECT c.id,c."userId",c."runId",c.sha256,c.title,c.source,c."createdAt"
      FROM run_captures c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
      WHERE c.id=$1 AND c."userId"=$2 AND c.kind='video' AND c.status='ready' AND c.sha256 ~ '^[a-f0-9]{64}$'`, [captureId,userId])
    if (!original) return null
    const previous = await cached(original)
    if (previous) return file(original,previous,signal)
    const { rows: [source] } = await database.query<Pick<Original,'storageKey' | 'inlineContent'>>(`SELECT "storageKey","inlineContent"
      FROM run_captures WHERE id=$1 AND "userId"=$2 AND sha256=$3 AND status='ready'`, [captureId,userId,original.sha256])
    if (!source) return null
    const bytes = source.inlineContent ? new Uint8Array(source.inlineContent)
      : source.storageKey ? await storage.read(source.storageKey,signal,100_000_000) : null
    if (!bytes || hash(bytes) !== original.sha256) throw new Error('capturePosterOriginalMismatch')
    const image = await render(bytes,signal)
    const digest = hash(image)
    // Each attempt owns its object even if two processes render the same bytes.
    // A failed writer can therefore clean up without deleting another's winner.
    const key = `${userId}/runs/${original.runId}/captures/${captureId}/posters/${original.sha256}-${randomUUID()}.jpg`
    const tx = await database.connect()
    let written = false
    let committed = false
    try {
      await tx.query('BEGIN')
      await tx.query("SET LOCAL lock_timeout = '5s'")
      await tx.query("SET LOCAL statement_timeout = '5s'")
      await tx.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
      // Same deletion fence as original capture writes; no object can appear
      // after the account's object-retirement manifest has been sealed.
      await tx.query('SELECT mikka_account_assert_writable($1)',[userId])
      const { rowCount } = await tx.query(`SELECT c.id FROM run_captures c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
        WHERE c.id=$1 AND c."userId"=$2 AND c."runId"=$3 AND c.sha256=$4 AND c.kind='video' AND c.status='ready' FOR SHARE OF c,r`,
      [captureId,userId,original.runId,original.sha256])
      if (!rowCount) { await tx.query('COMMIT'); committed=true; return null }
      signal.throwIfAborted()
      const kind = storage.kind()
      if (kind === 'r2') { written = true; await storage.write(key,image,signal) }
      signal.throwIfAborted()
      await tx.query(`INSERT INTO run_capture_posters("captureId","captureSha256","storageKey","inlineContent",size,sha256)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT ("captureId") DO NOTHING`,
      [captureId,original.sha256,key,kind === 'inline' ? Buffer.from(image) : null,image.length,digest])
      await tx.query('COMMIT')
      committed = true
    } catch (error) { if (!committed) await tx.query('ROLLBACK'); throw error }
    finally {
      tx.release()
      if (written && !committed) await storage.remove(key).catch(() => undefined)
    }
    const saved = await cached(original)
    // Concurrent generation may use a different decoder release during a
    // rolling deploy. Delete only this loser's distinct object, never the winner.
    if (written && saved?.storageKey !== key) await storage.remove(key).catch(() => undefined)
    return saved ? file(original,saved,signal) : null
  }
}

export const readCapturePoster = createCapturePosters(pool)
