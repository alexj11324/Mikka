import {z} from 'zod'
import type {EveScope} from './scope'

export interface EveRetrySource {position:number;id:string;payload:Record<string,unknown>;taskRequestSourceEventId:string}
async function canonical(scope:EveScope,id:string,payload:Record<string,unknown>) {
  if(payload.taskRequestSourceEventId===undefined)return {id,payload}
  const parsed=z.uuid().safeParse(payload.taskRequestSourceEventId)
  if(!parsed.success)throw new Error('notFound')
  const {pool}=await import('../db')
  const root=(await pool.query<{id:string;payload:Record<string,unknown>}>(`SELECT e.id,e.payload FROM coordinator_events e JOIN bots b ON b.id=e."botId" AND b."ownerId"=e."userId"
    WHERE e.id=$1 AND e."userId"=$2 AND e."botId"=$3 AND b."workspaceId"=$4 AND e.kind='user_message'`,[parsed.data,scope.ownerId,scope.botId,scope.workspaceId])).rows[0]
  if(!root)throw new Error('notFound')
  return root
}

/** The history position is only a selector. The host-owned user provenance
 * and original immutable event supply the task identity and full payload. */
export async function loadEveRetrySource(scope:EveScope,position:number):Promise<EveRetrySource|null> {
  const {pool}=await import('../db')
  const row=(await pool.query<{id:string;payload:Record<string,unknown>}>(`SELECT e.id,e.payload FROM coordinator_messages m
    JOIN coordinator_events e ON e.id::text=m.message#>>'{mikkaUserEvent,id}' AND e."userId"=m."userId" AND e."botId"=m."botId"
    JOIN bots b ON b.id=e."botId" AND b."ownerId"=e."userId" AND b."workspaceId"=$4
    WHERE m."userId"=$1 AND m."botId"=$2 AND m.position=$3 AND m.message->>'role'='user' AND m.message ? 'mikkaFailure' AND e.kind='user_message'`,[scope.ownerId,scope.botId,position,scope.workspaceId])).rows[0]
  if(!row)return null
  return {position,...row,taskRequestSourceEventId:(await canonical(scope,row.id,row.payload)).id}
}

export async function eveTaskRequestSource(scope:EveScope,id:string,payload:Record<string,unknown>) {
  const root=await canonical(scope,id,payload)
  return root.payload.taskDestination||root.payload.profileId||root.payload.taskTitle?root.id:undefined
}
