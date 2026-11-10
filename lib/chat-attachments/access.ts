import 'server-only'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { chatFileScopeSchema, type ChatFileScope } from '@mikka/protocol/chat-attachments'
import { db, pool, withDatabaseClient } from '@/lib/db'
import type { IssueReader } from '@/lib/issue-visibility'
import { activeTaskWorkspaces, borrowTaskWorkspaceMembership, taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { botChatResourceId, lockResourcesAccess, resourceActionAllowed } from '@/lib/resource-access/store'
import type { ResourceAction, ResourceReference } from '@/lib/resource-access/contract'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { ChatFileError } from './extract'

export type FileCustody = { workspaceId: string; resourceKind: 'chat' | 'thread' | 'group'; resourceId: string; scopeOwnerId: string }
type Query = Pick<PoolClient, 'query'>
const custodySchema = z.object({ workspaceId:z.uuid(),resourceKind:z.enum(['chat','thread','group']),resourceId:z.guid(),scopeOwnerId:z.string().min(1) })
export function fileCustody(value: unknown): FileCustody {
  const parsed=custodySchema.safeParse(value)
  if (!parsed.success) throw new ChatFileError('notFound')
  return parsed.data
}
export function custodyReference(custody: FileCustody): ResourceReference | null {
  return custody.resourceKind === 'group' ? null : { kind:custody.resourceKind,id:custody.resourceId,workspaceId:custody.workspaceId }
}
export async function resolveFileScope(scope: ChatFileScope, query: Query = pool): Promise<FileCustody> {
  const {kind,id}=chatFileScopeSchema.parse(scope)
  if(kind==='bot') {
    const {rows:[bot]}=await query.query<{workspaceId:string;ownerId:string|null}>('SELECT "workspaceId","ownerId" FROM bots WHERE id=$1',[id])
    if(!bot?.ownerId)throw new ChatFileError('notFound')
    return fileCustody({workspaceId:bot.workspaceId,scopeOwnerId:bot.ownerId,resourceKind:'chat',resourceId:botChatResourceId(bot.ownerId,id)})
  }
  const {rows:[row]}=kind==='thread'
    ? await query.query('SELECT "workspaceId",\'thread\' AS "resourceKind",id AS "resourceId","userId" AS "scopeOwnerId" FROM agent_runs WHERE id=$1',[id])
    : await query.query('SELECT "workspaceId",\'group\' AS "resourceKind",id AS "resourceId","createdBy" AS "scopeOwnerId" FROM conversations WHERE id=$1 AND kind=\'group\'',[id])
  return fileCustody(row)
}
export async function authorizeFileCustody(reader: IssueReader, custody: FileCustody, action: ResourceAction='canReadContent', query: Query=pool): Promise<void> {
  if(!(await activeTaskWorkspaces(reader,custody.workspaceId)).length)throw new ChatFileError('notFound')
  const userId=taskReaderScope(reader).userId,reference=custodyReference(custody)
  if(reference) {
    const {rows:[row]}=await query.query<{allowed:boolean}>('SELECT mikka_resource_acl_allowed(\'account\',$1,$2,$3,$4,$5) AS allowed',
      [userId,reference.workspaceId,reference.kind,reference.id,action])
    if(!row?.allowed)throw new ChatFileError('notFound')
  } else if(!(await query.query(`SELECT 1 FROM conversations c JOIN conversation_members m ON m."conversationId"=c.id
    WHERE c.id=$1 AND c."workspaceId"=$2 AND c.kind='group' AND m."memberType"='user' AND m."memberId"=$3 AND m."leftAt" IS NULL`,
    [custody.resourceId,custody.workspaceId,userId])).rowCount)throw new ChatFileError('notFound')
}

/** All writes acquire WS membership, then the union of APP ACL ancestors,
 * then the attachment/content rows. A caller's APP transaction must already
 * hold this exact WS lease, rather than reversing the split-database order. */
export async function withFileLease<T>(reader: IssueReader, workspaceId: string, work:(client:PoolClient)=>Promise<T>, executor?:PoolClient):Promise<T> {
  try {
    if(executor) {
      const borrowed=borrowTaskWorkspaceMembership(taskReaderScope(reader).userId,workspaceId)
      if(!borrowed)throw new ChatFileError('notFound')
      try {await borrowed.check();return await withDatabaseClient(executor,()=>work(executor))}
      finally {await borrowed.close()}
    }
    return await withTaskWorkspace(reader,workspaceId,async()=>{
      const client=await pool.connect()
      try {
        await client.query('BEGIN')
        const result=await withDatabaseClient(client,()=>work(client))
        await client.query('COMMIT')
        return result
      } catch(error) {await client.query('ROLLBACK');throw error}
      finally {client.release()}
    })
  } catch(error) {
    if(error instanceof ActionFailureError || error instanceof WorkspaceError)throw Object.assign(new ChatFileError('notFound'),{cause:error})
    throw error
  }
}
export async function lockFileCustodies(reader:IssueReader,custodies:readonly FileCustody[],action:ResourceAction,query:Query):Promise<void> {
  const userId=taskReaderScope(reader).userId
  await lockResourcesAccess(db,userId,custodies.flatMap(custody=>{
    const reference=custodyReference(custody)
    return reference?[{reference,action}]:[]
  }),false,false)
  for(const custody of custodies.filter(c=>c.resourceKind==='group').sort((a,b)=>a.resourceId.localeCompare(b.resourceId))) {
    // Membership changes serialize on the same conversation first.
    if(!(await query.query('SELECT 1 FROM conversations WHERE id=$1 AND "workspaceId"=$2 AND kind=\'group\' FOR SHARE',
      [custody.resourceId,custody.workspaceId])).rowCount)throw new ChatFileError('notFound')
    if(!(await query.query(`SELECT 1 FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='user'
      AND "memberId"=$2 AND "leftAt" IS NULL FOR SHARE`,[custody.resourceId,userId])).rowCount)throw new ChatFileError('notFound')
  }
  for(const custody of custodies) {
    const reference=custodyReference(custody)
    if(reference&&!await resourceActionAllowed(db,userId,reference,action))throw new ChatFileError('notFound')
  }
}
