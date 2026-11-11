import 'server-only'
import {createHash} from 'node:crypto'
import {Client,type ClientSession} from 'eve/client'
import {emptySessionView,foldEvents,idle,turns} from 'eve/events'
import type {MessageContent} from 'eve/channels'
import {assertEveScope,type EveScope} from './scope'
import {eveInternalOrigin} from './server-client'
import {loadEveRetrySource,type EveRetrySource} from './retry-source'
import {eveProductContext} from './submission'

type RetrySession=Pick<ClientSession,'id'|'snapshot'|'send'>
export interface EveRetryServices {open(scope:EveScope,headers:Readonly<Record<string,string>>):Promise<RetrySession>}
const defaultServices:EveRetryServices={async open(scope,headers){
  const base=new URL(eveInternalOrigin());base.searchParams.set('botId',scope.botId)
  return (await new Client({baseUrl:base.toString(),headers,redirect:'manual'}).sessions.create()).session
}}

export function eveRetryHeaders(requestHeaders:Headers,publicOrigin=process.env.BETTER_AUTH_URL) {
  const headers:Record<string,string>={}
  for(const key of ['cookie','authorization','origin','sec-fetch-site','x-mikka-workspace-id','x-mikka-locale']) {
    const value=requestHeaders.get(key);if(value!==null)headers[key]=value
  }
  if(!headers.cookie&&!headers.authorization)throw new Error('authRequired')
  // The product endpoint has authenticated this caller already. Native mobile
  // requests omit Origin; supply the configured app origin on this server hop.
  // Preserve an explicitly supplied value so the native CSRF guard can reject it.
  if(!requestHeaders.has('origin'))headers.origin=new URL(publicOrigin??'http://127.0.0.1:3000').origin
  return headers
}

export function eveRetrySubmission(sessionId:string,turnId:string,source:EveRetrySource) {
  const bytes=createHash('sha256').update(JSON.stringify(['mikka-eve-retry',sessionId,turnId,source.id])).digest().subarray(0,16)
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128
  const hex=bytes.toString('hex'),submissionId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
  const text=typeof source.payload.text==='string'?source.payload.text:''
  const files=Array.isArray(source.payload.images)?source.payload.images.flatMap(value=>value&&typeof value==='object'&&'dataUrl' in value&&typeof value.dataUrl==='string'&&'mediaType' in value&&typeof value.mediaType==='string'?[{type:'file' as const,data:value.dataUrl,mediaType:value.mediaType}]:[]):[]
  const message:MessageContent=files.length?[...(text?[{type:'text' as const,text}]:[]),...files]:text
  const clientContext=eveProductContext.parse({retryOf:source.position,taskDestination:source.payload.taskDestination,profileId:source.payload.profileId,taskTitle:source.payload.taskTitle})
  return {message,options:{clientContext,headers:{'x-mikka-submission-id':submissionId}}}
}

/** User-requested continuation through eve's normal send API. The native
 * snapshot owns failure/working state; no product lease starts another loop. */
export async function retryEveTurn(ownerId:string,botId:string,requestHeaders:Headers,services:EveRetryServices=defaultServices) {
  const {pool}=await import('../db')
  const bot=(await pool.query<{workspaceId:string}>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2',[botId,ownerId])).rows[0]
  if(!bot)return {queued:false as const,reason:'nothingToRetry' as const}
  const scope=await assertEveScope({ownerId,botId,workspaceId:bot.workspaceId,surface:'web'})
  const headers=eveRetryHeaders(requestHeaders)
  // Credentials are the current request's. A host service token would lose
  // the human session provenance that product tools still enforce.
  const session=await services.open(scope,headers)
  const view=foldEvents(emptySessionView(),(await session.snapshot()).events)
  if(!idle(view))return {queued:false as const,reason:'working' as const}
  const failed=turns(view).at(-1)
  if(failed?.outcome!=='failed')return {queued:false as const,reason:'nothingToRetry' as const}
  const row=(await pool.query<{position:number}>(`SELECT m.position FROM eve_turn_sources t
    JOIN coordinator_events e ON e.id=t.source_event_id AND e."userId"=$3 AND e."botId"=$4 AND e.kind='user_message'
    JOIN coordinator_messages m ON m."userId"=e."userId" AND m."botId"=e."botId" AND m.message#>>'{mikkaUserEvent,id}'=e.id::text
    WHERE t.session_id=$1 AND t.turn_id=$2 ORDER BY m.position DESC LIMIT 1`,[session.id,failed.turnId,ownerId,botId])).rows[0]
  if(!row)return {queued:false as const,reason:'nothingToRetry' as const}
  const source=await loadEveRetrySource(scope,row.position)
  if(!source)return {queued:false as const,reason:'nothingToRetry' as const}
  const retry=eveRetrySubmission(session.id,failed.turnId,source)
  await session.send(retry.message,retry.options)
  return {queued:true as const}
}
