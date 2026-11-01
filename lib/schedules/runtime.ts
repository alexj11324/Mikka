import 'server-only'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { pool, withDatabaseClient } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { issueForUser } from '@/lib/issue-access'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { ScheduleStore, type WorkspaceGuard } from './store'
import { ScheduleError, type Actor, type Command, type ScheduledRead } from './contract'

const guard: WorkspaceGuard = async(owner,workspace,work)=>{
  if(!workspace)return work()
  const tx=await workspacePool.connect()
  try{
    await tx.query('BEGIN')
    const member=await tx.query(`SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`,[workspace,owner])
    if(!member.rowCount)throw new ScheduleError('scheduleWorkspaceAccessDenied',403)
    const value=await work();await tx.query('COMMIT');return value
  }catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
}
export function schedules(){return new ScheduleStore(pool,guard,async(tx,owner,id)=>{
  await tx.query('SELECT id FROM issues WHERE id=$1 FOR SHARE',[id])
  const row=await withDatabaseClient(tx,()=>issueForUser(owner,id))
  if(!row)return null
  return {id:row.id,title:row.title,status:row.status}
},async(tx,owner,value)=>withDatabaseClient(tx,()=>assertCredentialSafeChat(owner,value)),coordinatorEnabled)}

export async function scheduleActor(ownerId:string,botId:string|null,sourceEventId?:string):Promise<Actor>{
  const row=botId?(await pool.query<{workspaceId:string}>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2',[botId,ownerId])).rows[0]:null
  if(botId&&!row)throw new ScheduleError('scheduleConversationUnavailable',403)
  return {ownerId,botId,workspaceId:row?.workspaceId??null,...(sourceEventId?{sourceEventId}:{})}
}
export async function executeScheduleCommand(owner:string,botId:string|null,sourceEventId:string|undefined,command:Command){return schedules().command(await scheduleActor(owner,botId,sourceEventId),command)}
export async function sweepSchedules(){const {wakeOwners,...counts}=await schedules().tick();await Promise.allSettled(wakeOwners.map(owner=>wakeCoordinator(owner)));return counts}
export async function assertScheduledRead(owner:string,botId:string|null,scope:ScheduledRead){return schedules().assertRead(owner,botId,scope)}
