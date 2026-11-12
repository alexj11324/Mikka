import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { UserModelMessage } from 'ai'
import {
  CHAT_FILE_CHUNK_BYTES,
  CHAT_FILE_MAX_BYTES,
  CHAT_FILE_MAX_COUNT,
  CHAT_FILE_MAX_TEXT,
  chatFileScopeSchema,
  splitChatFiles,
  supportedChatFile,
  type ChatFile,
  type ChatFileScope,
} from '@mikka/protocol/chat-attachments'
import { pool } from '@/lib/db'
import { armDueTimerAfterCommit, armDueTimerSoon } from '@/lib/due-timer'
import { workspacePool } from '@/lib/workspace-db'
import {
  artifactStorage,
  deleteArtifactObject,
  getArtifactObjectStream,
  putArtifactObject,
  presignArtifactGet,
} from '@/lib/artifacts/storage'
import { readRunChain } from '@/lib/run-chain'
import { boundedChatFileBytes, ChatFileError, extractChatFile } from './extract'

export interface FileRow extends ChatFile {
  userId: string
  botId: string | null
  conversationId: string | null
  runId: string | null
  state: 'uploading' | 'ready'
  sha256: string | null
  storageKey: string | null
  uploadKey: string | null
  inlineData: Buffer | null
  textContent: string | null
  usedAt: Date | null
  uploadExpiresAt: Date | null
  removedAt: Date | null
}
const columns =
  'id,"userId","botId","conversationId","runId",name,"mediaType",size,state,sha256,"storageKey","uploadKey","inlineData","textContent","usedAt","uploadExpiresAt","removedAt"'
const publicFile = ({ id, name, size, mediaType }: ChatFile): ChatFile => ({ id, name, size, mediaType })
export const fileScope = (file: Pick<FileRow, 'botId' | 'conversationId' | 'runId'>): ChatFileScope =>
  file.botId
    ? { kind: 'bot', id: file.botId }
    : file.conversationId
      ? { kind: 'group', id: file.conversationId }
      : { kind: 'thread', id: file.runId! }

/** Live membership/ownership is checked at upload, completion and every read. */
export async function authorizeFileScope(
  userId: string,
  scope: ChatFileScope,
  database: Pick<PoolClient, 'query'> = pool,
): Promise<string> {
  const { kind, id } = chatFileScopeSchema.parse(scope)
  let threadWorkspace: string | undefined
  if (kind === 'thread') {
    const run = (
      await database.query<{
        workspaceId: string | null
        bindingWorkspace: string | null
        issueId: string | null
      }>(
        `SELECT b."workspaceId",c."workspaceId" AS "bindingWorkspace",r."issueId" FROM agent_runs r LEFT JOIN bots b ON b.id=r."botId" LEFT JOIN computer_run_bindings c ON c."runId"=r.id WHERE r.id=$1 AND r."userId"=$2`,
        [id, userId],
      )
    ).rows[0]
    if (!run) throw new ChatFileError('notFound')
    const task = run.issueId
      ? (
          await workspacePool.query<{ workspaceId: string }>(
            'SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$1',
            [run.issueId],
          )
        ).rows[0]?.workspaceId
      : undefined
    const named = [
      ...new Set(
        [run.workspaceId, run.bindingWorkspace, task].filter((value): value is string => Boolean(value)),
      ),
    ]
    if (named.length > 1) throw new ChatFileError('notFound')
    threadWorkspace =
      named[0] ??
      (
        await workspacePool.query<{ id: string }>(
          'SELECT id FROM mikka_workspaces WHERE "userId"=$1 AND kind=\'personal\' ORDER BY "createdAt",id LIMIT 1',
          [userId],
        )
      ).rows[0]?.id
  }
  const result =
    kind === 'bot'
      ? await database.query<{ workspaceId: string }>(
          'SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2',
          [id, userId],
        )
      : kind === 'group'
        ? await database.query<{ workspaceId: string }>(
            `SELECT c."workspaceId" FROM conversations c JOIN conversation_members m ON m."conversationId"=c.id
        WHERE c.id=$1 AND m."memberType"='user' AND m."memberId"=$2 AND m."leftAt" IS NULL`,
            [id, userId],
          )
        : { rows: threadWorkspace ? [{ workspaceId: threadWorkspace }] : [] }
  const workspace = result.rows[0]?.workspaceId
  if (!workspace) throw new ChatFileError('notFound')
  const active = await workspacePool.query(
    'SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\'',
    [workspace, userId],
  )
  if (!active.rowCount) throw new ChatFileError('notFound')
  return workspace
}

export async function beginChatFile(
  userId: string,
  scope: ChatFileScope,
  input: { name: string; size: number; mediaType: string },
) {
  await authorizeFileScope(userId, scope)
  const name =
    [...input.name]
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join('')
      .split(/[\\/]/)
      .at(-1)
      ?.trim() ?? ''
  if (!name || name.length > 255 || !supportedChatFile(name, input.mediaType))
    throw new ChatFileError('unsupported')
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > CHAT_FILE_MAX_BYTES)
    throw new ChatFileError('tooLarge')
  const count = await pool.query(
    `SELECT count(*)::int AS n FROM chat_attachments WHERE "userId"=$1 AND "usedAt" IS NULL AND "removedAt" IS NULL AND "createdAt">now()-interval '1 day'`,
    [userId],
  )
  if (count.rows[0].n >= 100) throw new ChatFileError('tooMany')
  artifactStorage() // Fail before uploading if production storage is not configured.
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000)
  await pool.query(
    `INSERT INTO chat_attachments(id,"userId","botId","conversationId","runId",name,"mediaType",size,"uploadKey","uploadExpiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      userId,
      scope.kind === 'bot' ? scope.id : null,
      scope.kind === 'group' ? scope.id : null,
      scope.kind === 'thread' ? scope.id : null,
      name,
      input.mediaType.slice(0, 100),
      input.size,
      null,
      expiresAt,
    ],
  )
  // An unused upload is cleaned up a day later by the account-deletions due timer (#1371).
  armDueTimerSoon('account-deletions')
  return { id, chunkSize: CHAT_FILE_CHUNK_BYTES }
}

/** Same-origin parts stay below the platform's body limit; each accepted offset is immutable on retry. */
export async function uploadChatFilePart(
  userId: string,
  id: string,
  part: number,
  bytes: Uint8Array,
  tokenWorkspaceId?: string,
) {
  if (
    !Number.isSafeInteger(part) ||
    part < 0 ||
    part >= Math.ceil(CHAT_FILE_MAX_BYTES / CHAT_FILE_CHUNK_BYTES)
  )
    throw new ChatFileError('unreadable')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = (
      await client.query<FileRow & { received: number }>(
        `SELECT ${columns.replace('"inlineData",', '')},coalesce(octet_length("inlineData"),0) AS received FROM chat_attachments WHERE id=$1 AND "userId"=$2 FOR UPDATE`,
        [id, userId],
      )
    ).rows[0]
    if (
      !row ||
      row.removedAt ||
      row.state !== 'uploading' ||
      !row.uploadExpiresAt ||
      row.uploadExpiresAt.getTime() < Date.now()
    )
      throw new ChatFileError('notFound')
    const workspace = await authorizeFileScope(userId, fileScope(row), client)
    if (tokenWorkspaceId && workspace !== tokenWorkspaceId) throw new ChatFileError('notFound')
    await client.query('SELECT mikka_account_assert_writable($1)', [userId])
    const offset = part * CHAT_FILE_CHUNK_BYTES
    const expected = Math.min(CHAT_FILE_CHUNK_BYTES, row.size - offset)
    if (expected <= 0 || bytes.length !== expected || offset > row.received)
      throw new ChatFileError('unreadable')
    if (offset < row.received) {
      const same = (
        await client.query<{ same: boolean }>(
          'SELECT substring("inlineData" FROM $2 FOR $3)=$4::bytea AS same FROM chat_attachments WHERE id=$1',
          [id, offset + 1, bytes.length, Buffer.from(bytes)],
        )
      ).rows[0]?.same
      if (!same) throw new ChatFileError('unreadable')
    } else {
      await client.query(
        'UPDATE chat_attachments SET "inlineData"=coalesce("inlineData",\'\'::bytea)||$2::bytea WHERE id=$1',
        [id, Buffer.from(bytes)],
      )
    }
    await client.query('COMMIT')
    return { received: Math.max(row.received, offset + bytes.length) }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function lockChatFileForCompletion(
  client: PoolClient,
  userId: string,
  id: string,
  tokenWorkspaceId?: string,
) {
  const row = (
    await client.query<FileRow>(
      `SELECT ${columns} FROM chat_attachments WHERE id=$1 AND "userId"=$2 FOR UPDATE`,
      [id, userId],
    )
  ).rows[0]
  if (!row || row.removedAt) throw new ChatFileError('notFound')
  const workspaceId = await authorizeFileScope(userId, fileScope(row), client)
  if (tokenWorkspaceId && workspaceId !== tokenWorkspaceId) throw new ChatFileError('notFound')
  await client.query('SELECT mikka_account_assert_writable($1)', [userId])
  if (row.state !== 'ready' && (!row.uploadExpiresAt || row.uploadExpiresAt.getTime() < Date.now()))
    throw new ChatFileError('unavailable')
  return { row, workspaceId }
}

/** Freeze the uploaded object under a new immutable key before making it readable. */
export async function completeChatFile(
  userId: string,
  id: string,
  inline?: Uint8Array,
  tokenWorkspaceId?: string,
): Promise<ChatFile> {
  const client = await pool.connect()
  let stage = 'read'
  try {
    await client.query('BEGIN')
    let { row, workspaceId } = await lockChatFileForCompletion(client, userId, id, tokenWorkspaceId)
    if (row.state === 'ready') {
      await client.query('COMMIT')
      return publicFile(row)
    }
    const bytes =
      inline ??
      row.inlineData ??
      (row.uploadKey
        ? await boundedChatFileBytes(
            await getArtifactObjectStream(row.uploadKey, AbortSignal.timeout(60_000)),
            row.size,
          )
        : undefined)
    if (!bytes || bytes.length !== row.size) throw new ChatFileError('unreadable')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const key = artifactStorage() === 'r2' ? `chat-files/${userId}/${id}/${hash}` : null
    if (key !== row.storageKey) {
      // Keep the final object discoverable to the existing draft/account cleanup trigger,
      // including when the process disappears after PUT but before the ready row commits.
      // An earlier unpublished attempt used a different body; only its locked draft owns it.
      if (row.storageKey) await deleteArtifactObject(row.storageKey)
      await client.query('UPDATE chat_attachments SET "storageKey"=$2 WHERE id=$1', [id, key])
      await client.query('COMMIT')
      await client.query('BEGIN')
      const fresh = await lockChatFileForCompletion(client, userId, id, tokenWorkspaceId)
      row = fresh.row
      workspaceId = fresh.workspaceId
      if (row.state === 'ready') {
        await client.query('COMMIT')
        return publicFile(row)
      }
      if (row.storageKey !== key) throw new ChatFileError('unavailable')
    }
    stage = 'extract'
    const extracted = await extractChatFile(row.name, row.mediaType, bytes)
    let { text } = extracted
    const { mediaType } = extracted
    if (mediaType.startsWith('audio/')) {
      stage = 'transcribe'
      const { transcribeChatAudio } = await import('./transcribe')
      text = await transcribeChatAudio(userId, workspaceId, bytes, client)
      if (text.length > CHAT_FILE_MAX_TEXT) throw new ChatFileError('tooLong')
    }
    stage = 'store'
    if (key) await putArtifactObject(key, new Uint8Array(bytes), mediaType)
    stage = 'commit'
    await client.query(
      `UPDATE chat_attachments SET state='ready',sha256=$3,"storageKey"=$4,"inlineData"=$5,"textContent"=$6,"mediaType"=$7 WHERE id=$1 AND "userId"=$2`,
      [id, userId, hash, key, key ? null : Buffer.from(bytes), text, mediaType],
    )
    await client.query('COMMIT')
    return publicFile({ ...row, mediaType })
  } catch (error) {
    if (!(error instanceof ChatFileError)) {
      // Do not log file names, contents, database details or signed storage URLs.
      const diagnostic = error as { name?: unknown; code?: unknown; cause?: { code?: unknown }; message?: unknown }
      const label = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined
      console.error('Chat attachment completion failed', {
        stage,
        name: label(diagnostic?.name),
        code: label(diagnostic?.code),
        causeCode: label(diagnostic?.cause?.code),
        storageStatus: typeof diagnostic?.message === 'string' ? /^R2 put failed: (\d{3})$/.exec(diagnostic.message)?.[1] : undefined,
      })
    }
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function readChatFile(userId: string, id: string): Promise<FileRow> {
  const row = (
    await pool.query<FileRow>(
      `SELECT ${columns} FROM chat_attachments WHERE id=$1 AND state='ready' AND "removedAt" IS NULL`,
      [id],
    )
  ).rows[0]
  if (!row || (row.userId !== userId && (!row.conversationId || !row.usedAt)))
    throw new ChatFileError('notFound')
  await authorizeFileScope(userId, fileScope(row))
  return row
}
export async function chatFileBytes(file: FileRow): Promise<Uint8Array> {
  const bytes =
    file.inlineData ??
    (file.storageKey
      ? await boundedChatFileBytes(
          await getArtifactObjectStream(file.storageKey, AbortSignal.timeout(60_000)),
          file.size,
        )
      : null)
  if (
    !bytes ||
    bytes.length !== file.size ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new ChatFileError('unreadable')
  return bytes
}
export async function removeChatFile(userId: string, id: string, tokenWorkspaceId?: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = (
      await client.query<FileRow>(
        `SELECT ${columns} FROM chat_attachments WHERE id=$1 AND "userId"=$2 AND "usedAt" IS NULL FOR UPDATE`,
        [id, userId],
      )
    ).rows[0]
    if (row) {
      const workspace = await authorizeFileScope(userId, fileScope(row), client)
      if (tokenWorkspaceId && workspace !== tokenWorkspaceId) throw new ChatFileError('notFound')
      await client.query('UPDATE chat_attachments SET "removedAt"=now() WHERE id=$1 AND "usedAt" IS NULL', [
        id,
      ])
      // A removed draft is cleaned up once its upload grant expires (#1371).
      armDueTimerAfterCommit(client, 'account-deletions')
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** Only ready, same-chat, caller-owned files can become part of a new submission. */
export async function validateChatFiles(
  userId: string,
  scope: ChatFileScope,
  text: string,
  executor?: PoolClient,
) {
  const refs = splitChatFiles(text).files
  if (!refs.length) return
  if (refs.length > CHAT_FILE_MAX_COUNT) throw new ChatFileError('tooMany')
  const client = executor ?? (await pool.connect())
  try {
    if (!executor) await client.query('BEGIN')
    await authorizeFileScope(userId, scope, client)
    const files = (
      await client.query<FileRow>(
        `SELECT ${columns} FROM chat_attachments WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND state='ready' AND "removedAt" IS NULL ORDER BY id FOR UPDATE`,
        [refs.map((ref) => ref.id), userId],
      )
    ).rows
    if (files.length !== refs.length) throw new ChatFileError('notFound')
    let textSize = 0
    for (const file of files) {
      const actual = fileScope(file)
      let same = actual.kind === scope.kind && actual.id === scope.id
      if (!same && actual.kind === 'thread' && scope.kind === 'thread')
        same = Boolean(
          (await readRunChain(client, userId, scope.id))?.attempts.some(
            (attempt) => attempt.runId === actual.id,
          ),
        )
      if (file.userId !== userId || !same) throw new ChatFileError('notFound')
      textSize += file.textContent?.length ?? 0
    }
    if (textSize > CHAT_FILE_MAX_TEXT) throw new ChatFileError('tooLong')
    await client.query(
      'UPDATE chat_attachments SET "usedAt"=coalesce("usedAt",now()) WHERE "userId"=$1 AND id=ANY($2::uuid[])',
      [userId, refs.map((ref) => ref.id)],
    )
    if (!executor) await client.query('COMMIT')
  } catch (error) {
    if (!executor) await client.query('ROLLBACK')
    throw error
  } finally {
    if (!executor) client.release()
  }
}

/** Bounded cleanup of cancelled/abandoned uploads, expired PUT grants and deleted-chat objects. */
export async function cleanupChatFiles() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `DELETE FROM chat_attachments WHERE id IN (SELECT id FROM chat_attachments WHERE "usedAt" IS NULL AND ("removedAt" IS NOT NULL OR "createdAt"<now()-interval '1 day') AND ("uploadExpiresAt" IS NULL OR "uploadExpiresAt"<now()) LIMIT 50 FOR UPDATE SKIP LOCKED)`,
    )
    await client.query(
      `INSERT INTO chat_attachment_retirements("storageKey","userId") SELECT "uploadKey","userId" FROM chat_attachments WHERE "uploadKey" IS NOT NULL AND "uploadExpiresAt"<now() ON CONFLICT DO NOTHING`,
    )
    await client.query(
      'UPDATE chat_attachments SET "uploadKey"=NULL,"uploadExpiresAt"=NULL WHERE "uploadExpiresAt"<now()',
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  const retired = (
    await pool.query<{ storageKey: string }>(
      'SELECT "storageKey" FROM chat_attachment_retirements WHERE "notBefore"<=now() ORDER BY "notBefore" LIMIT 50',
    )
  ).rows
  let removed = 0
  for (const row of retired) {
    try {
      await deleteArtifactObject(row.storageKey)
      await pool.query('DELETE FROM chat_attachment_retirements WHERE "storageKey"=$1', [row.storageKey])
      removed++
    } catch {
      /* Durable queue retains failed deletes. */
    }
  }
  return { retired: removed }
}

type UserContent = Extract<UserModelMessage['content'], unknown[]>
export async function chatFileContent(
  userId: string,
  scope: ChatFileScope,
  text: string,
): Promise<UserContent> {
  const parsed = splitChatFiles(text)
  if (!parsed.files.length) return [{ type: 'text', text }]
  const parts: UserContent = [{ type: 'text', text: parsed.text }]
  let budget = 0
  for (const ref of parsed.files) {
    const file = await readChatFile(userId, ref.id)
    const actual = fileScope(file)
    if (actual.kind !== scope.kind || actual.id !== scope.id || !file.usedAt)
      throw new ChatFileError('notFound')
    if (file.textContent !== null) {
      budget += file.textContent.length
      if (budget > CHAT_FILE_MAX_TEXT) throw new ChatFileError('tooLong')
      parts.push({
        type: 'text',
        text: JSON.stringify({
          kind: 'attached_file',
          name: file.name,
          authority: 'untrusted_document',
          content: file.textContent,
        }),
      })
    } else {
      const bytes = await chatFileBytes(file)
      if (file.mediaType.startsWith('image/')) {
        const { default: sharp } = await import('sharp')
        const pixels = await sharp(bytes, { limitInputPixels: 40_000_000 })
          .rotate()
          .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer()
        parts.push({
          type: 'image',
          image: `data:image/webp;base64,${pixels.toString('base64')}`,
          mediaType: 'image/webp',
        })
      } else
        parts.push({
          type: 'file',
          data: Buffer.from(bytes).toString('base64'),
          mediaType: file.mediaType,
          filename: file.name,
        })
    }
  }
  return parts
}

export async function chatFileDownloadUrl(file: FileRow, download = true): Promise<string | null> {
  if (!file.storageKey) return null
  const inline = !download && /^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/)/.test(file.mediaType)
  return presignArtifactGet(
    file.storageKey,
    file.mediaType,
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  )
}
