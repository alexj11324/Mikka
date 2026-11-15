import 'server-only'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { pool, withDatabaseClient } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { issueForUser } from '@/lib/issue-access'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { armDueTimerSoon } from '@/lib/due-timer'
import { nextScheduleDue, ScheduleStore, type AutomationSeams, type WorkspaceGuard } from './store'
import { ScheduleError, type Actor, type Command, type DispatchTask, type ScheduledRead } from './contract'

const guard: WorkspaceGuard = async(owner,workspace,work)=>{
  if(!workspace)return work({role:'member'})
  const tx=await workspacePool.connect()
  try{
    await tx.query('BEGIN')
    const member=await tx.query<{role:'owner'|'admin'|'member'}>(`SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`,[workspace,owner])
    if(!member.rowCount)throw new ScheduleError('scheduleWorkspaceAccessDenied',403)
    const value=await work({role:member.rows[0].role});await tx.query('COMMIT');return value
  }catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
}
/** The Bot a dispatch_task hands its request to: the named Bot, or the creator's Coordinator in that workspace. */
async function dispatchBot(ownerId:string,workspaceId:string,task:DispatchTask){
  if(task.botId)return task.botId
  const {coordinatorBot}=await import('@/lib/coordinator/coordinator-bot')
  return (await coordinatorBot(ownerId,workspaceId,{backfill:false})).botId
}
/**
 * dispatch_task runs as its creator, checked again at every run: the Bot is still theirs and live in this workspace,
 * its repository is still installed here, the picked computer and Agent profile still exist and are on, and task
 * creation is on. A failed check is a failed run with its reason; nothing is widened for scheduled work.
 */
const automation:AutomationSeams={
  async check(tx,ownerId,workspaceId,task){
    const {issueMutationsEnabled}=await import('@/lib/coordinator/issue-tools-enabled')
    if(!issueMutationsEnabled())throw new ScheduleError('issueToolsDisabled',503)
    const botId=await dispatchBot(ownerId,workspaceId,task)
    const bot=(await tx.query<{repository:string|null}>('SELECT repository FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "archivedAt" IS NULL FOR SHARE',[botId,ownerId,workspaceId])).rows[0]
    if(!bot)throw new ScheduleError('scheduleBotUnavailable',403)
    if(bot.repository){
      const {repositoryAvailable}=await import('@/lib/workspace-admin/bots')
      if(!await repositoryAvailable(workspaceId,bot.repository))throw new ScheduleError('scheduleRepositoryUnavailable',403)
    }
    if(task.destination?.kind==='device'&&!(await tx.query('SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind=\'local\' AND enabled=true',[task.destination.deviceId,ownerId])).rowCount)throw new ScheduleError('scheduleDeviceUnavailable',403)
    const {BUILTIN_AGENT_PROFILE_ID}=await import('@/lib/factory/agent-profile-reference')
    if(task.profileId&&task.profileId!==BUILTIN_AGENT_PROFILE_ID){
      const {readProfileRow}=await import('@/lib/factory/agent-profile-store')
      const profile=await readProfileRow(tx,{ownerId,workspaceId},task.profileId).catch(()=>null)
      if(!profile||profile.archivedAt||!profile.definition.enabled)throw new ScheduleError('scheduleProfileUnavailable',403)
    }
  },
  /** The creator's 创建并派发, keyed by the occurrence: a retried run finds the same request and the same task. */
  async dispatch({ownerId,workspaceId,scheduleId,occurrenceId,task}){
    const botId=await dispatchBot(ownerId,workspaceId,task)
    const [{db},{recordPersonalSubmission},{createIssueFromRequest}]=await Promise.all([import('@/lib/db'),import('@/lib/coordinator-submission'),import('@/lib/coordinator/issue-create')])
    const {eventId}=await recordPersonalSubmission(db,ownerId,task.prompt,{botId,submissionId:occurrenceId,
      taskCommand:{version:1,intent:'create_and_dispatch',description:task.prompt},schedule:{scheduleId,occurrenceId},
      ...(task.title?{taskTitle:task.title}:{}),...(task.destination?{taskDestination:task.destination}:{}),...(task.profileId?{profileId:task.profileId}:{})})
    const created=await createIssueFromRequest(ownerId,{sourceEventId:eventId,title:task.title??task.prompt.split(/\r?\n/,1)[0]!.slice(0,200)})
    const row=(await pool.query<{title:string;status:string;identifier:string|null}>(`SELECT i.title,i.status,r.identifier FROM issues i
      LEFT JOIN task_creation_receipts r ON r."taskId"=i.id AND r."userId"=$2 WHERE i.id=$1`,[created.issueId,ownerId])).rows[0]
    if(!row)throw new ScheduleError('scheduleDispatchUnavailable',503)
    return {id:created.issueId,title:row.title,status:row.status,identifier:row.identifier,eventId}
  },
  async changed(tx,workspaceId){await (await import('@/lib/live/lists')).scheduleListChanged(tx,workspaceId)},
}
export function schedules(){return new ScheduleStore(pool,guard,async(tx,owner,id)=>{
  await tx.query('SELECT id FROM issues WHERE id=$1 FOR SHARE',[id])
  const row=await withDatabaseClient(tx,()=>issueForUser(owner,id))
  if(!row)return null
  return {id:row.id,title:row.title,status:row.status}
},async(tx,owner,value)=>withDatabaseClient(tx,()=>assertCredentialSafeChat(owner,value)),coordinatorEnabled,undefined,automation)}

export async function scheduleActor(ownerId:string,botId:string|null,sourceEventId?:string,direct?:true):Promise<Actor>{
  const row=botId?(await pool.query<{workspaceId:string}>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2',[botId,ownerId])).rows[0]:null
  if(botId&&!row)throw new ScheduleError('scheduleConversationUnavailable',403)
  return {ownerId,botId,workspaceId:row?.workspaceId??null,...(sourceEventId?{sourceEventId}:{}),...(direct?{direct}:{})}
}
/** A committed create, update, resume or 立即运行 can move the next due time earlier: the schedules timer re-reads it (#1212). */
const MOVES_DUE=new Set(['create','update','resume','run_now'])
/**
 * The one writer. A chat command names the person's message (`sourceEventId`); the 自动化 page passes `{ direct: true }`
 * from a server action that authenticated the person, with the workspace's Coordinator as the chat that gets the reports.
 */
export async function executeScheduleCommand(owner:string,botId:string|null,sourceEventId:string|undefined,command:Command,options:{direct?:true}={}){
  const result=await schedules().command(await scheduleActor(owner,botId,sourceEventId,options.direct),command)
  if(typeof command==='object'&&command&&MOVES_DUE.has((command as {action?:string}).action??''))armDueTimerSoon('schedules')
  return result
}
/** A scheduled read that failed is retried 30 s later, earlier than the lease the timer sleeps to. */
export async function failScheduledRead(claim:{id:string;lease_token:string},error:unknown){await schedules().fail(claim,error);armDueTimerSoon('schedules')}
/** The earliest persisted due time of any schedule work (epoch ms), or null. */
export function scheduleNextDue(){return nextScheduleDue(pool)}
export async function sweepSchedules(){await (await import('@/lib/inbox/runtime')).expireInboxSnoozes();const {wakeOwners,...counts}=await schedules().tick();await Promise.allSettled(wakeOwners.map(owner=>wakeCoordinator(owner)));return counts}
export async function assertScheduledRead(owner:string,botId:string|null,scope:ScheduledRead){return schedules().assertRead(owner,botId,scope)}
