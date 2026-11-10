import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { UserModelMessage } from 'ai'
import {
  CHAT_FILE_CHUNK_BYTES,
  CHAT_FILE_MAX_BYTES,
  CHAT_FILE_MAX_COUNT,
  CHAT_FILE_MAX_TEXT,
  splitChatFiles,
  supportedChatFile,
  type ChatFile,
  type ChatFileScope,
} from '@mikka/protocol/chat-attachments'
import { pool } from '@/lib/db'
import { armDueTimerAfterCommit } from '@/lib/due-timer'
import {
  artifactStorage,
  deleteArtifactObject,
  getArtifactObjectStream,
  putArtifactObject,
} from '@/lib/artifacts/storage'
import type { IssueReader } from '@/lib/issue-visibility'
import { taskReaderScope } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { authorizeFileCustody, fileCustody, lockFileCustodies, resolveFileScope, withFileLease, type FileCustody } from './access'
import { boundedChatFileBytes, ChatFileError, extractChatFile } from './extract'

export interface FileRow extends ChatFile, FileCustody {
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
  'id,"userId","botId","conversationId","runId","workspaceId","resourceKind","resourceId","scopeOwnerId",name,"mediaType",size,state,sha256,"storageKey","uploadKey","inlineData","textContent","usedAt","uploadExpiresAt","removedAt"'
const custodyColumns = 'id,"userId","workspaceId","resourceKind","resourceId","scopeOwnerId","usedAt"'
const publicFile = ({ id, name, size, mediaType }: ChatFile): ChatFile => ({ id, name, size, mediaType })
export const fileScope = (file: Pick<FileRow, 'botId' | 'conversationId' | 'runId'>): ChatFileScope =>
  file.botId
    ? { kind: 'bot', id: file.botId }
    : file.conversationId
      ? { kind: 'group', id: file.conversationId }
      : { kind: 'thread', id: file.runId! }

function pinnedReader(reader: IssueReader, workspaceId?: string): IssueReader {
  if(!workspaceId)return reader
  const scope=taskReaderScope(reader)
  if(scope.workspaceId&&scope.workspaceId!==workspaceId)throw new ChatFileError('notFound')
  return {id:scope.userId,[tokenWorkspace]:workspaceId,
    ...(typeof reader!=='string'&&reader[enterprisePrincipal]?{[enterprisePrincipal]:reader[enterprisePrincipal]}:{})}
}

/** Live tenant, Enterprise and resource ACL at every file boundary. */
export async function authorizeFileScope(
  reader: IssueReader,
  scope: ChatFileScope,
  database: Pick<PoolClient, 'query'> = pool,
): Promise<string> {
  const custody = await resolveFileScope(scope, database)
  await authorizeFileCustody(reader, custody, 'canReadContent', database)
  return custody.workspaceId
}

async function locateFile(id: string, query: Pick<PoolClient, 'query'> = pool) {
  const { rows: [row] } = await query.query<FileCustody & {userId:string;usedAt:Date|null}>(
    `SELECT ${custodyColumns} FROM chat_attachments WHERE id=$1 AND "removedAt" IS NULL`, [id])
  return { ...fileCustody(row), userId:row.userId,usedAt:row.usedAt }
}

export async function beginChatFile(
  reader: IssueReader,
  scope: ChatFileScope,
  input: { name: string; size: number; mediaType: string },
) {
  const userId=taskReaderScope(reader).userId
  const custody=await resolveFileScope(scope)
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
  artifactStorage()
  return withFileLease(reader,custody.workspaceId,async client=>{
    await lockFileCustodies(reader,[custody],'canComment',client)
    // Transfer and upload cannot disagree about the structural Chat identity.
    if(scope.kind==='bot' && !(await client.query('SELECT 1 FROM bots WHERE id=$1 AND "workspaceId"=$2 AND "ownerId"=$3 FOR SHARE',
      [scope.id,custody.workspaceId,custody.scopeOwnerId])).rowCount)throw new ChatFileError('notFound')
    const count=await client.query(`SELECT count(*)::int AS n FROM chat_attachments WHERE "userId"=$1 AND "usedAt" IS NULL AND "removedAt" IS NULL AND "createdAt">now()-interval '1 day'`,[userId])
    if(count.rows[0].n>=100)throw new ChatFileError('tooMany')
    const id=randomUUID(),expiresAt=new Date(Date.now()+24*60*60_000)
    await client.query(`INSERT INTO chat_attachments(id,"userId","botId","conversationId","runId",name,"mediaType",size,"uploadExpiresAt", "workspaceId","resourceKind","resourceId","scopeOwnerId")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id,userId,scope.kind==='bot'?scope.id:null,scope.kind==='group'?scope.id:null,scope.kind==='thread'?scope.id:null,
        name,input.mediaType.slice(0,100),input.size,expiresAt,custody.workspaceId,custody.resourceKind,custody.resourceId,custody.scopeOwnerId])
    armDueTimerAfterCommit(client,'account-deletions')
    return {id,chunkSize:CHAT_FILE_CHUNK_BYTES}
  })
}

/** Same-origin parts stay below the platform's body limit; each accepted offset is immutable on retry. */
export async function uploadChatFilePart(
  reader: IssueReader,
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
  reader = pinnedReader(reader, tokenWorkspaceId)
  const userId = taskReaderScope(reader).userId, custody = await locateFile(id)
  if (custody.userId !== userId) throw new ChatFileError('notFound')
  return withFileLease(reader, custody.workspaceId, async client => {
    await lockFileCustodies(reader,[custody],'canComment',client)
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
    return { received: Math.max(row.received, offset + bytes.length) }
  })
}

/** Freeze the uploaded object under a new immutable key before making it readable. */
export async function completeChatFile(
  reader: IssueReader,
  id: string,
  inline?: Uint8Array,
  tokenWorkspaceId?: string,
): Promise<ChatFile> {
  reader = pinnedReader(reader, tokenWorkspaceId)
  const userId = taskReaderScope(reader).userId, custody = await locateFile(id)
  if (custody.userId !== userId) throw new ChatFileError('notFound')
  let stage = 'read'
  try { return await withFileLease(reader,custody.workspaceId,async client=>{
    await lockFileCustodies(reader,[custody],'canComment',client)
    const row = (
      await client.query<FileRow>(
        `SELECT ${columns} FROM chat_attachments WHERE id=$1 AND "userId"=$2 FOR UPDATE`,
        [id, userId],
      )
    ).rows[0]
    if (!row || row.removedAt) throw new ChatFileError('notFound')
    const workspaceId = custody.workspaceId
    await client.query('SELECT mikka_account_assert_writable($1)', [userId])
    if (row.state === 'ready') {
      return publicFile(row)
    }
    if (!row.uploadExpiresAt || row.uploadExpiresAt.getTime() < Date.now())
      throw new ChatFileError('unavailable')
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
    const hash = createHash('sha256').update(bytes).digest('hex')
    const key = artifactStorage() === 'r2' ? `chat-files/${userId}/${id}/${hash}` : null
    stage = 'store'
    if (key) await putArtifactObject(key, new Uint8Array(bytes), mediaType)
    stage = 'commit'
    await client.query(
      `UPDATE chat_attachments SET state='ready',sha256=$3,"storageKey"=$4,"inlineData"=$5,"textContent"=$6,"mediaType"=$7 WHERE id=$1 AND "userId"=$2`,
      [id, userId, hash, key, key ? null : Buffer.from(bytes), text, mediaType],
    )
    return publicFile({ ...row, mediaType })
  }) } catch (error) {
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
    throw error
  }
}

export async function readChatFile(reader: IssueReader, id: string): Promise<FileRow> {
  const custody=await locateFile(id),userId=taskReaderScope(reader).userId
  if(custody.userId!==userId&&!custody.usedAt)throw new ChatFileError('notFound')
  return withFileLease(reader,custody.workspaceId,async client=>{
    await lockFileCustodies(reader,[custody],'canReadContent',client)
    const {rows:[row]}=await client.query<FileRow>(`SELECT ${columns} FROM chat_attachments
      WHERE id=$1 AND state='ready' AND "removedAt" IS NULL AND ("userId"=$2 OR "usedAt" IS NOT NULL)`,[id,userId])
    if(!row)throw new ChatFileError('notFound')
    return row
  })
}

/** Native/Worker download authority comes from the persisted run, never the
 * VM owner's identity alone. A shared run cannot import a private Chat/file
 * merely because its execution owner can read it. */
export async function readChatFileForRun(query: Pick<PoolClient,'query'>, input: {
  runId:string;executionOwnerId:string;actorId:string;workspaceId:string;
}, id:string):Promise<FileRow> {
  const {rows:[run]}=await query.query<{personal:boolean;clean:boolean;authorizationId:string|null}>(`SELECT
    mikka_run_personal_resources_allowed(r.id) AS personal,
    r."agentDefinition"->>'contextIsolation'='shared_clean'
      AND mikka_run_clean_execution_allowed(r.id,r."deviceId")
      AND EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE d."runId"=r.id AND d.attempt=greatest(r.attempt,1)
        AND d."deviceId"=r."deviceId" AND NOT d."personalResources" AND d.provenance='claim') AS clean,
    r."agentDefinition"->'executionIdentity'->>'collaborationAuthorizationId' AS "authorizationId"
    FROM agent_runs r WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3
      AND coalesce(r."agentDefinition"->'executionIdentity'->>'actor',r."userId")=$4
      AND r.status IN ('preparing','running','waiting_input','finishing') AND r."stopRequestedAt" IS NULL
      AND r."deviceId" IS NOT NULL AND r."leaseExpiresAt">clock_timestamp()
      AND mikka_resource_acl_allowed('account',$4,$3,'thread',r.id,'canSteer')
      AND mikka_resource_acl_allowed('account',$2,$3,'thread',r.id,'canSteer')
      AND (position($5 in r.prompt)>0 OR EXISTS(SELECT 1 FROM run_messages m WHERE m."runId"=r.id
        AND m."userId" IN ($2,$4) AND position($5 in m.text)>0))`,
    [input.runId,input.executionOwnerId,input.workspaceId,input.actorId,`[mikka-file:${id}:`])
  if(!run || !run.personal&&!run.clean)throw new ChatFileError('notFound')
  // The current receipt/model and actual Actor session can expire independently
  // of the run lease. This reuses native admission instead of inventing a grant.
  const identity=await (await import('@/lib/execution-identity')).activeExecutionIdentity(query,input.runId,input.executionOwnerId)
  if(!identity&&!run.personal)throw new ChatFileError('notFound')
  let reader:IssueReader={id:input.actorId,[tokenWorkspace]:input.workspaceId}
  if(input.actorId!==input.executionOwnerId) {
    const {rows:[receipt]}=await query.query<{sessionId:string}>(`SELECT a."sessionId" FROM thread_execution_authorizations a
      JOIN "session" s ON s.id=a."sessionId" AND s."userId"=$2 AND s."expiresAt">clock_timestamp()
      WHERE a.id::text=$1 AND a."actorId"=$2 AND a."ownerId"=$3 AND a."workspaceId"=$4 AND a."runId"=$5
        AND a."releasedAt" IS NULL AND a."expiresAt">clock_timestamp()`,
      [run.authorizationId,input.actorId,input.executionOwnerId,input.workspaceId,input.runId])
    if(!receipt)throw new ChatFileError('notFound')
    reader={...reader,[enterprisePrincipal]:{kind:'session',sessionId:receipt.sessionId}}
  }
  const custody=await locateFile(id,query)
  if(custody.workspaceId!==input.workspaceId||!custody.usedAt)throw new ChatFileError('notFound')
  await authorizeFileCustody(reader,custody,'canReadContent',query)
  const {rows:[file]}=await query.query<FileRow>(`SELECT ${columns} FROM chat_attachments a WHERE id=$1
    AND state='ready' AND "removedAt" IS NULL AND "usedAt" IS NOT NULL AND "workspaceId"=$2
    AND ($3::boolean OR mikka_chat_attachment_flows_to($2,"resourceKind","resourceId",'thread',$4))`,
    [id,input.workspaceId,run.personal&&input.actorId===input.executionOwnerId,input.runId])
  if(!file)throw new ChatFileError('notFound')
  return file
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
export async function removeChatFile(reader: IssueReader, id: string, tokenWorkspaceId?: string) {
  reader=pinnedReader(reader,tokenWorkspaceId)
  const custody=await locateFile(id),userId=taskReaderScope(reader).userId
  if(custody.userId!==userId)throw new ChatFileError('notFound')
  return withFileLease(reader,custody.workspaceId,async client=>{
    await lockFileCustodies(reader,[custody],'canComment',client)
    await client.query('UPDATE chat_attachments SET "removedAt"=coalesce("removedAt",now()) WHERE id=$1 AND "userId"=$2 AND "usedAt" IS NULL',[id,userId])
    armDueTimerAfterCommit(client,'account-deletions')
  })
}

/** Drafts are uploader-only. A submitted source must remain in the exact Chat
 * or an ancestor Thread; copying its UUID cannot widen the audience. */
export async function validateChatFiles(reader: IssueReader, scope: ChatFileScope, text: string, executor?: PoolClient) {
  const refs=splitChatFiles(text).files
  if(!refs.length)return
  if(refs.length>CHAT_FILE_MAX_COUNT)throw new ChatFileError('tooMany')
  const userId=taskReaderScope(reader).userId,query=executor??pool,custody=await resolveFileScope(scope,query)
  const {rows:identities}=await query.query<FileRow>(`SELECT ${custodyColumns} FROM chat_attachments
    WHERE id=ANY($1::uuid[]) AND state='ready' AND "removedAt" IS NULL AND ("userId"=$2 OR "usedAt" IS NOT NULL)`,[refs.map(ref=>ref.id),userId])
  if(identities.length!==refs.length)throw new ChatFileError('notFound')
  const sources=identities.map(row=>fileCustody(row))
  if(sources.some(source=>source.workspaceId!==custody.workspaceId))throw new ChatFileError('notFound')
  return withFileLease(reader,custody.workspaceId,async client=>{
    await lockFileCustodies(reader,[custody,...sources],'canReadContent',client)
    await authorizeFileCustody(reader,custody,'canComment',client)
    const {rows:files}=await client.query<FileRow>(`SELECT ${columns.replace('"inlineData",','')} FROM chat_attachments
      WHERE id=ANY($1::uuid[]) AND state='ready' AND "removedAt" IS NULL AND ("userId"=$2 OR "usedAt" IS NOT NULL) ORDER BY id FOR UPDATE`,[refs.map(ref=>ref.id),userId])
    if(files.length!==refs.length)throw new ChatFileError('notFound')
    let textSize=0
    for(const file of files) {
      let same=file.resourceKind===custody.resourceKind&&file.resourceId===custody.resourceId
      if(!same&&file.resourceKind==='thread'&&custody.resourceKind==='thread') {
        const {rows:[path]}=await client.query<{allowed:boolean}>(`WITH RECURSIVE parents AS (
          SELECT kind,id,"parentKind","parentId",0 AS depth FROM resource_access_policies WHERE kind='thread' AND id=$1 AND "workspaceId"=$3
          UNION ALL SELECT p.kind,p.id,p."parentKind",p."parentId",a.depth+1 FROM parents a
            JOIN resource_access_policies p ON p.kind=a."parentKind" AND p.id=a."parentId" AND p."workspaceId"=$3 WHERE a.depth<32
        ) SELECT EXISTS(SELECT 1 FROM parents WHERE kind='thread' AND id=$2) AS allowed`,[custody.resourceId,file.resourceId,custody.workspaceId])
        same=path?.allowed===true
      }
      if(!same || file.userId!==userId&&!file.usedAt)throw new ChatFileError('notFound')
      textSize+=file.textContent?.length??0
    }
    if(textSize>CHAT_FILE_MAX_TEXT)throw new ChatFileError('tooLong')
    await client.query('UPDATE chat_attachments SET "usedAt"=coalesce("usedAt",now()) WHERE id=ANY($1::uuid[])',[refs.map(ref=>ref.id)])
  },executor)
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
  reader: IssueReader,
  scope: ChatFileScope,
  text: string,
): Promise<UserContent> {
  const parsed = splitChatFiles(text)
  if (!parsed.files.length) return [{ type: 'text', text }]
  const parts: UserContent = [{ type: 'text', text: parsed.text }]
  let budget = 0
  for (const ref of parsed.files) {
    const file = await readChatFile(reader, ref.id)
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

/** The URL has no bearer storage grant. Every use returns through the normal
 * authenticated route, including after sharing, transfer or membership changes. */
export function chatFileDownloadUrl(id: string, requestUrl: string): string {
  const url=new URL(requestUrl)
  url.search=''
  url.hash=''
  if(!url.pathname.endsWith(`/attachments/${id}`))throw new ChatFileError('notFound')
  url.searchParams.set('download','')
  return url.href
}
