import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { pool } from '@/lib/db'
import { artifactFileName } from '@/lib/artifacts/limits'
import { getArtifactObjectStream } from '@/lib/artifacts/storage'
import type { AccountExport } from './export'

type FileKind = 'artifact' | 'capture' | 'checkpoint'
interface File {
  kind: FileKind; id: string; name: string; size: number | null; sha256: string | null
  contentType: string; unavailable?: string; artifactId?: string; version?: number; runId?: string
}
const CHUNK_BYTES = 64 * 1024
const RECHECK_BYTES = 1024 * 1024

/** Select only owned metadata first; load a single file at a time, never all recording/checkpoint bytes. */
export async function accountExportFiles(userId: string, database: Pool = pool): Promise<File[]> {
  const [artifacts, captures, checkpoints] = await Promise.all([
    database.query<{ id: string; artifactId: string; kind: 'html' | 'markdown'; title: string; version: number; size: number; sha256: string }>(`SELECT v.id,v."artifactId",a.kind,a.title,v.version,v.size,v.sha256
      FROM artifact_versions v JOIN artifacts a ON a.id=v."artifactId" WHERE a."userId"=$1 ORDER BY v."artifactId",v.version`, [userId]),
    database.query<{ id: string; runId: string; status: string; contentType: string; size: number | null; sha256: string | null }>(`SELECT c.id,c."runId",c.status,c."contentType",c.size,c.sha256 FROM run_captures c
      JOIN agent_runs r ON r.id=c."runId" WHERE c."userId"=$1 AND r."userId"=$1 ORDER BY c."createdAt",c.id`, [userId]),
    database.query<{ id: string; size: number; sha256: string; unavailableReason: string | null }>(`SELECT c."runId" AS id,octet_length(c.patch)::int AS size,encode(sha256(c.patch),'hex') AS sha256,c."unavailableReason" FROM run_checkpoints c
      JOIN agent_runs r ON r.id=c."runId" WHERE c."userId"=$1 AND r."userId"=$1 ORDER BY c."runId"`, [userId]),
  ])
  return [
    ...artifacts.rows.map(row => ({ kind: 'artifact' as const, id: row.id, artifactId: row.artifactId, version: row.version,
      name: artifactFileName(row.title, row.kind, row.version), contentType: row.kind === 'html' ? 'text/html' : 'text/markdown', size: row.size, sha256: row.sha256 })),
    ...captures.rows.map(row => ({ kind: 'capture' as const, id: row.id, runId: row.runId, name: `capture-${row.id}`, contentType: row.contentType,
      size: row.size, sha256: row.sha256, ...(row.status === 'ready' ? {} : { unavailable: `capture_${row.status}` }) })),
    ...checkpoints.rows.map(row => ({ kind: 'checkpoint' as const, id: row.id, runId: row.id, name: `run-${row.id}.patch.gz`, contentType: 'application/gzip',
      size: row.size, sha256: row.sha256, ...(row.unavailableReason ? { unavailable: `checkpoint_${row.unavailableReason}` } : {}) })),
  ]
}

async function ownedFile(database: Pool, userId: string, file: File, content: boolean, includeUnavailable = false) {
  const projection = content ? ',v."storageKey",v."inlineContent"' : ''
  if (file.kind === 'artifact') return (await database.query<{ storageKey?: string; inlineContent?: string | null }>(`SELECT v.id${projection} FROM artifact_versions v JOIN artifacts a ON a.id=v."artifactId" WHERE v.id=$1 AND a."userId"=$2`, [file.id, userId])).rows[0]
  if (file.kind === 'capture') return (await database.query<{ storageKey?: string | null; inlineContent?: Buffer | null }>(`SELECT c.id${content ? ',c."storageKey",c."inlineContent"' : ''} FROM run_captures c JOIN agent_runs r ON r.id=c."runId" WHERE c.id=$1 AND c."userId"=$2 AND r."userId"=$2 ${includeUnavailable ? '' : "AND c.status='ready'"}`, [file.id, userId])).rows[0]
  return (await database.query<{ patch?: Buffer }>(`SELECT c."runId"${content ? ',c.patch' : ''} FROM run_checkpoints c JOIN agent_runs r ON r.id=c."runId" WHERE c."runId"=$1 AND c."userId"=$2 AND r."userId"=$2 ${includeUnavailable ? '' : 'AND c."unavailableReason" IS NULL'}`, [file.id, userId])).rows[0]
}
function inlineStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return }
    controller.enqueue(bytes.subarray(offset, offset + CHUNK_BYTES)); offset += CHUNK_BYTES
  } })
}
async function openFile(database: Pool, userId: string, file: File, signal: AbortSignal) {
  const row = await ownedFile(database, userId, file, true)
  if (!row) throw new Error('Account export file is no longer available')
  if ('patch' in row && row.patch) return inlineStream(row.patch)
  if ('inlineContent' in row && row.inlineContent !== null && row.inlineContent !== undefined) return inlineStream(typeof row.inlineContent === 'string' ? Buffer.from(row.inlineContent, 'utf8') : row.inlineContent)
  if (!('storageKey' in row) || !row.storageKey) throw new Error('Account export file storage is missing')
  return getArtifactObjectStream(row.storageKey, signal)
}

/** Existing JSON metadata plus portable file bytes. Missing/changed files abort rather than publish a valid partial export. */
export function accountExportBody(data: AccountExport, files: File[], userId: string, options: {
  assertCurrent: () => Promise<void>; signal: AbortSignal; database?: Pool
}) {
  const database = options.database ?? pool, abort = new AbortController()
  const signal = AbortSignal.any([options.signal, abort.signal]), encoder = new TextEncoder()
  async function* generate() {
    let exported = 0, unavailable = 0, bytes = 0
    await options.assertCurrent(); signal.throwIfAborted()
    yield encoder.encode(`${JSON.stringify(data).slice(0, -1)},"files":[`)
    for (let index = 0; index < files.length; index++) {
      const file = files[index]
      await options.assertCurrent(); signal.throwIfAborted()
      if (index) yield encoder.encode(',')
      const metadata = { ...file, encoding: 'base64' }
      if (file.unavailable) {
        if (!await ownedFile(database, userId, file, false, true)) throw new Error('Account export file is no longer available')
        unavailable++
        yield encoder.encode(JSON.stringify({ ...metadata, content: null }))
        continue
      }
      if (file.size === null || !Number.isSafeInteger(file.size) || file.size < 0 || !file.sha256 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Account export file integrity metadata is missing')
      const reader = (await openFile(database, userId, file, signal)).getReader()
      const hash = createHash('sha256')
      let seen = 0, sinceCheck = 0, carry = Buffer.alloc(0), ended = false
      try {
        yield encoder.encode(`${JSON.stringify(metadata).slice(0, -1)},"content":"`)
        while (true) {
          signal.throwIfAborted()
          const next = await reader.read()
          if (next.done) { ended = true; break }
          for (let offset = 0; offset < next.value.length; offset += CHUNK_BYTES) {
            const chunk = next.value.subarray(offset, offset + CHUNK_BYTES)
            seen += chunk.length; sinceCheck += chunk.length
            if (seen > file.size) throw new Error('Account export file integrity mismatch')
            if (sinceCheck >= RECHECK_BYTES) {
              await options.assertCurrent()
              if (!await ownedFile(database, userId, file, false)) throw new Error('Account export file ownership changed')
              sinceCheck = 0
            }
            signal.throwIfAborted(); hash.update(chunk)
            const joined = Buffer.concat([carry, chunk]), length = joined.length - joined.length % 3
            if (length) yield encoder.encode(joined.subarray(0, length).toString('base64'))
            carry = joined.subarray(length)
          }
        }
        if (seen !== file.size || hash.digest('hex') !== file.sha256) throw new Error('Account export file integrity mismatch')
        await options.assertCurrent()
        if (!await ownedFile(database, userId, file, false)) throw new Error('Account export file ownership changed')
        signal.throwIfAborted()
        if (carry.length) yield encoder.encode(carry.toString('base64'))
        yield encoder.encode('"}')
        exported++; bytes += seen
      } finally {
        if (!ended) await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    await options.assertCurrent(); signal.throwIfAborted()
    yield encoder.encode(`],"fileManifest":${JSON.stringify({ complete: unavailable === 0, files: files.length, exported, unavailable, bytes })}}`)
  }
  const iterator = generate()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value) }
      catch (error) { abort.abort(); await iterator.return(undefined); controller.error(error) }
    },
    async cancel() { abort.abort(); await iterator.return(undefined) },
  })
}
