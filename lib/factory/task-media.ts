import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { CaptureContentType, CaptureSource } from '@mikka/protocol/capture'
import { actingContext } from '../activity-actor'
import { withBasePath } from '../base-path'
import { tokenWorkspace } from '../tokens/principal'
import { FactoryError } from './contract'
import { maskFactoryNote } from './note-mask'
import type { createFactoryStore, FactoryTask } from './store'

export interface FactoryTaskMedia {
  captureId: string
  runId: string
  kind: 'image' | 'video'
  contentType: CaptureContentType
  source: CaptureSource
  title: string
  size: number
  durationMs: number | null
  createdAt: string
  url: string
  posterUrl: string | null
}

type MediaRow = Omit<FactoryTaskMedia, 'createdAt' | 'url' | 'posterUrl'> & { createdAt: Date | string }

function tokenReader(userId: string) {
  const context=actingContext.getStore()
  return context?.userId===userId && context.tokenWorkspaceId ? {id:userId,[tokenWorkspace]:context.tokenWorkspaceId} : null
}

/** All ready media for an already-authorized task, including older attempts and
 * files that were never selected for an acceptance report. No capture bytes,
 * object keys, prompts or bearer/share tokens enter the sidebar read model. */
export async function readFactoryTaskMedia(tx: Pick<PoolClient, 'query'>, task: Pick<FactoryTask, 'id' | 'userId' | 'issueId' | 'workspaceId'>): Promise<FactoryTaskMedia[]> {
  const { rows } = await tx.query<MediaRow>(`SELECT c.id AS "captureId",c."runId",c.kind,c."contentType",c.source,c.title,c.size,c."durationMs",c."createdAt"
    FROM run_captures c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
    WHERE c."userId"=$2 AND r."issueId"=$3 AND r."workspaceId"=$4 AND (c."issueId" IS NULL OR c."issueId"=$3) AND c.status='ready'
      AND EXISTS (SELECT 1 FROM factory_attempts a WHERE a."taskId"=$1 AND a."runId"=r.id)
      AND mikka_resource_acl_allowed('account',$5,r."workspaceId",'thread',r.id,'canReadContent')
    ORDER BY c."createdAt",c.id`, [task.id,task.userId,task.issueId,task.workspaceId ?? null,actingContext.getStore()?.userId ?? task.userId])
  const reader=tokenReader(task.userId)
  // readFactoryActivity keeps this helper inside withDatabaseClient(tx), so
  // the existing capture/run scope reads share its repeatable-read snapshot.
  const outside=reader ? await (await import('../tokens/scope')).runsOutsideToken(reader,[...new Set(rows.map(row=>row.runId))]) : null
  return rows.filter(row=>!outside?.has(row.runId)).map(row => {
    const url = withBasePath(`/api/factory/tasks/${encodeURIComponent(task.id)}/media/${encodeURIComponent(row.captureId)}`)
    return { ...row, title: maskFactoryNote(row.title), size: row.size ?? 0,
      createdAt: new Date(row.createdAt).toISOString(), url, posterUrl: row.kind === 'video' ? `${url}/poster` : null }
  })
}

/** Use the exact task-detail owner/Bot/source/issue authorization before binding
 * the file. A capture id alone, even one owned by the caller, is insufficient. */
export async function authorizeFactoryTaskCapture(pool: Pool, store: Pick<ReturnType<typeof createFactoryStore>, 'readTask'>,
  userId: string, taskId: string, captureId: string): Promise<{ ownerId: string }> {
  if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(captureId).success) throw new FactoryError('factoryNotFound')
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const task = await store.readTask(tx,userId,taskId)
    const { rows:[capture] } = await tx.query<{runId:string}>(`SELECT c."runId" FROM run_captures c
      JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
      WHERE c.id=$1 AND c."userId"=$2 AND r."issueId"=$3 AND r."workspaceId"=$5 AND (c."issueId" IS NULL OR c."issueId"=$3) AND c.status='ready'
        AND EXISTS (SELECT 1 FROM factory_attempts a WHERE a."taskId"=$4 AND a."runId"=r.id)
        AND mikka_resource_acl_allowed('account',$6,r."workspaceId",'thread',r.id,'canReadContent')`,
    [captureId,task.userId,task.issueId,task.id,task.workspaceId ?? null,userId])
    if (!capture) throw new FactoryError('factoryNotFound')
    const reader=tokenReader(task.userId)
    if(reader){
      const [{withDatabaseClient},{runOutsideToken}]=await Promise.all([import('../db'),import('../tokens/scope')])
      if(await withDatabaseClient(tx,()=>runOutsideToken(reader,capture.runId)))throw new FactoryError('factoryNotFound')
    }
    await tx.query('COMMIT')
    return { ownerId: task.userId }
  } catch (error) { await tx.query('ROLLBACK'); throw error }
  finally { tx.release() }
}
