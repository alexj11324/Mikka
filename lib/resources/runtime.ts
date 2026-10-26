import {AsyncLocalStorage} from 'node:async_hooks'
import {createWebService,SearchProviderError,type SearchResponse,type ScrapeResponse} from '@/lib/search'
import {createFirecrawlProvider} from '@/lib/search/firecrawl'
import {webUrlSchema} from '@/lib/search/url-schema'
import 'server-only'
import { intentDigest } from '@/lib/operations/action-intents'
import { createGateway, type gateway } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { pool } from '@/lib/db'
import { policyStore } from '@/lib/policy/runtime'
import { AGENT_ROUTE, coordinatorRoute } from '@/lib/policy/model'
import { PolicyError } from '@/lib/policy/contract'
import { QuotaError } from '@/lib/quota/errors'
import { ResourceModelExecution,ModelExecutionFailure, type ModelExecutionScope, type ModelSourceFence } from './model-execution'
import type { WakeDelivery, WakeAdmission } from '@/lib/coordinator/inbox-receipts'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { DECISION_MODEL, DECISIONS_URL,answersByName,type DecisionResponse } from '@/lib/coordinator/decision'
import {tierFromDecision} from '@/lib/coordinator/triage'

export type ModelSource =
  | { kind:'coordinator';ownerId:string;workspaceId:string;operationId:string;generation:number;holder:string;delivery:WakeDelivery }
  | { kind:'triage';ownerId:string;workspaceId:string;operationId:string;generation:number }
  | { kind:'schedule';ownerId:string;workspaceId:string;operationId:string;generation:number;occurrenceId:string;scheduleId:string;version:number;leaseToken:string }
type GatewayModel=ReturnType<typeof gateway.languageModel>
export type ModelOptions=Parameters<GatewayModel['doGenerate']>[0]
const digest=intentDigest

/** The keyless test transport changes destination after logical route checks. */
function controlledOrigin(){
  const origin=process.env.MIKKA_RESOURCE_TEST_ORIGIN
  if(!origin)return null
  const target=new URL(origin),db=process.env.MIKKA_DATABASE_URL
  if(process.env.CI!=='true'||target.origin!==origin||target.hostname!=='127.0.0.1'||target.protocol!=='http:'||!db||new URL(db).hostname!=='127.0.0.1'||!new URL(db).pathname.endsWith('_176')||['VERCEL','AI_GATEWAY_API_KEY','DECISION_GATEWAY_API_KEY','OPENAI_API_KEY','OPENCODE_API_KEY','COMPOSIO_API_KEY','FIRECRAWL_API_KEY'].some(k=>process.env[k]))throw new Error('resourceControlledTransportInvalid')
  return origin
}
export const resourceTestTransportEnabled=()=>Boolean(controlledOrigin())
export const resourceDecisionEnabled=()=>Boolean(process.env.DECISION_GATEWAY_API_KEY)||resourceTestTransportEnabled()
const transport:typeof fetch=async(input,init)=>{
  const origin=controlledOrigin()
  if(!origin)return fetch(input,init)
  const logical=new URL(input instanceof Request?input.url:String(input))
  if(!['https://ai-gateway.vercel.sh/v4/ai/language-model',DECISIONS_URL,AGENT_ROUTE.endpoint,'https://api.firecrawl.dev/v2/search','https://api.firecrawl.dev/v2/scrape'].includes(logical.href))throw new Error('resourceControlledRouteInvalid')
  return fetch(origin+(logical.hostname==='api.firecrawl.dev'?logical.pathname:'/model'),{...init,headers:{...Object.fromEntries(new Headers(init?.headers)), 'x-controlled-logical-endpoint':logical.href}})
}
function execution(operationId?:string){
  const send:typeof fetch=(input,init)=>{
    if(!controlledOrigin())return transport(input,init)
    const headers=new Headers(init?.headers)
    if(operationId)headers.set('x-controlled-operation-id',operationId)
    return transport(input,{...init,headers})
  }
  return new ResourceModelExecution(pool,policyStore(),send)
}
export const sourceFence=(source:ModelSource):ModelSourceFence=>async(tx,_reservation,deadline,workspace)=>{
  if(source.kind==='coordinator'){
    const {fenceCoordinatorModel}=await import('@/lib/coordinator/inbox-runtime')
    return fenceCoordinatorModel(tx,workspace,{...source,eventId:source.operationId},deadline)
  }
  if(source.kind==='triage'){
    const {fenceCoordinatorTriage}=await import('@/lib/coordinator/inbox-runtime')
    return fenceCoordinatorTriage(tx,workspace,{...source,eventId:source.operationId})
  }
  const {fenceScheduledModel}=await import('@/lib/schedules/model-outcomes')
  return fenceScheduledModel(tx,source,deadline)
}
export async function generateResourceModel(source:ModelSource,modelId:string,resource:ModelExecutionScope['resource'],stepKey:string,options:ModelOptions){
  if((resource==='schedule.model'&&source.kind!=='schedule')||(resource.startsWith('coordinator.')&&source.kind!=='coordinator'))throw new QuotaError('modelScopeMismatch',403)
  const route=resource==='schedule.model'?AGENT_ROUTE:coordinatorRoute(modelId)
  const binding={kind:source.kind,operationId:source.operationId,workspaceId:source.workspaceId,generation:source.generation,
    ...(source.kind==='schedule'?{occurrenceId:source.occurrenceId,scheduleId:source.scheduleId,version:source.version}:{}),
    leaseDigest:digest(source.kind==='coordinator'?source.delivery:source.kind==='schedule'?source.leaseToken:null),promptDigest:digest([options.prompt,options.tools])}
  return execution(source.operationId).run({...source,resource,stepKey,binding},route,async(send,signal)=>{
    const model=resource==='schedule.model'
      ? createOpenAICompatible({name:'opencode',apiKey:controlledOrigin()?'isolated-controlled-transport':process.env.OPENCODE_API_KEY!,baseURL:'https://opencode.ai/zen/go/v1',headers:{'x-opencode-session':source.operationId},fetch:send})(modelId)
      : createGateway({fetch:send,...(controlledOrigin()?{apiKey:'isolated-controlled-transport'}:{})}).languageModel(modelId)
    return model.doGenerate({...options,abortSignal:signal})
  },{fence:sourceFence(source),signal:options.abortSignal,usage:value=>({inputTokens:value.usage.inputTokens.total,outputTokens:value.usage.outputTokens.total})})
}

export async function runResourceDecision(source:Extract<ModelSource,{kind:'triage'}>,purpose:string,input:string,questions:unknown){
  const route={provider:'vercel_gateway',model:DECISION_MODEL,endpoint:DECISIONS_URL,region:'unknown' as const}
  return execution(source.operationId).run({...source,resource:'gateway.decision',stepKey:'triage-decision',binding:{purpose,inputDigest:digest(input),questionsDigest:digest(questions)}},route,async(send,signal)=>{
    const response=await send(DECISIONS_URL,{method:'POST',headers:{Authorization:`Bearer ${controlledOrigin()?'isolated-controlled-transport':process.env.DECISION_GATEWAY_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:DECISION_MODEL,input,questions}),signal})
    return response.json()
  },{fence:sourceFence(source),timeoutMs:5000,leaseMs:10000,commit:async(tx,reservation,value,workspace)=>{
    await sourceFence(source)(tx,reservation,new Date(),workspace)
    const event=(await tx.query('SELECT kind,wake_tool_receipts FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE',[source.operationId,source.ownerId])).rows[0]
    const answer=answersByName(value as DecisionResponse).get('needsPerson')
    const tier=answer?.type==='predicate'?tierFromDecision(answer.probability,event.kind):event.kind==='run_report'?'background':'result'
    const receipts=event.wake_tool_receipts??{}
    if(Object.keys(receipts).length>=128)throw new QuotaError('modelDecisionReceiptLimit',409)
    const receipt={binding:digest([source.operationId,source.generation]),value:{tier,decisionDigest:digest(value)}}
    await tx.query('UPDATE coordinator_events SET tier=$3,wake_tool_receipts=$4,wake_next_at=$5,wake_error=NULL WHERE id=$1 AND "userId"=$2',[source.operationId,source.ownerId,tier,{...receipts,[`decision:${source.generation}`]:receipt},new Date()])
  }})
}

/** No grant or reservation is invented at dispatch. Actual sends independently
 * activate and revalidate the existing canonical quota ledger. */
export const publicWakeAdmission:WakeAdmission=async(scope,_phase)=>{
  try{
    if(!scope.workspaceId)return {admitted:false,retryAt:new Date(Date.now()+60000)}
    const event=(await pool.query('SELECT tier,wake_workspace_id,wake_replays FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND processed_at IS NULL',[scope.operationId,scope.ownerId])).rows[0]
    if(!event||event.wake_workspace_id!==scope.workspaceId||event.wake_replays!==scope.generation)return {admitted:false,retryAt:new Date(Date.now()+60000)}
    const triage=event.tier===null
    const route=triage?{provider:'vercel_gateway',model:DECISION_MODEL,endpoint:DECISIONS_URL,region:'unknown' as const}:coordinatorRoute(COORDINATOR_MODEL)
    await execution().available({...scope,workspaceId:scope.workspaceId,resource:triage?'gateway.decision':'coordinator.model'},route)
    return {admitted:true}
  }catch(error){
    if(!(error instanceof QuotaError)&&!(error instanceof PolicyError))throw error
    return {admitted:false,retryAt:new Date(Date.now()+Math.min(900000,Math.max(1000,error instanceof QuotaError?error.retryAfter*1000:60000)))}
  }
}

// One shared provider service retains its existing bounded search cache and
// throttle. The async scope supplies the already admitted actual SDK fetch.
// No caller can install a second permissive transport in the Bot harness.
const webScope=new AsyncLocalStorage<{source:Extract<ModelSource,{kind:'coordinator'}>;send:typeof fetch}>()
const webProvider=createFirecrawlProvider((input,init)=>{
  const scope=webScope.getStore()
  if(!scope)throw new QuotaError('modelScopeUnavailable',403)
  return scope.send(input,init)
},{resolve:async hostname=>{
  if(controlledOrigin()){
    if(hostname!=='fixture.public.invalid')throw new Error('resourceControlledHostInvalid')
    return [{address:'8.8.8.8'}]
  }
  const {lookup}=await import('node:dns/promises')
  return lookup(hostname,{all:true})
}})
const webService=createWebService({provider:webProvider,authorize:ctx=>{
  const scope=webScope.getStore()
  return Boolean(scope&&ctx.userId===scope.source.ownerId&&ctx.workspaceId===scope.source.workspaceId&&ctx.caller==='coordinator')
}})
export async function runResourceWeb(source:Extract<ModelSource,{kind:'coordinator'}>,operation:'search'|'scrape',input:{query?:string;limit?:number;url?:string}):Promise<SearchResponse|ScrapeResponse>{
 if(source.kind!=='coordinator')throw new QuotaError('modelScopeMismatch',403)
 const safe:{query:string;limit:number}|{url:string}=operation==='search'?{query:String(input.query??'').trim(),limit:input.limit??5}:{url:webUrlSchema.parse(input.url)}
 if('query'in safe&&(safe.query.length<2||safe.query.length>300||!Number.isInteger(safe.limit)||safe.limit<1||safe.limit>10))throw new QuotaError('webInputInvalid',400)
 const key=`web:${source.generation}:${digest([operation,safe])}`
 const binding=digest([source.ownerId,source.workspaceId,source.operationId,source.generation,operation,safe])
 let cached:{binding:string;value:SearchResponse|ScrapeResponse}|undefined
 const authorize=async(tx:import('pg').PoolClient,workspace:import('@/lib/policy/sql-client').PolicyClient,deadline:Date)=>{
  const {fenceCoordinatorModel}=await import('@/lib/coordinator/inbox-runtime')
  await fenceCoordinatorModel(tx,workspace,{...source,eventId:source.operationId},deadline)
 }
 try{
 return await execution(source.operationId).runTool({...source,stepKey:key,resource:operation==='search'?'web.search':'web.scrape',binding:{operationId:source.operationId,workspaceId:source.workspaceId,generation:source.generation,inputDigest:binding}},async(send,signal)=>{
  if(cached)return cached.value
  const value=await webScope.run({source,send},()=>operation==='search'
   ?webService.search(('query'in safe?safe.query:''),{userId:source.ownerId,workspaceId:source.workspaceId,caller:'coordinator'},{limit:'limit'in safe?safe.limit:5,signal})
   :webService.scrape(('url'in safe?safe.url:''),{userId:source.ownerId,workspaceId:source.workspaceId,caller:'coordinator'},{signal}))
  if(value.ok&&'page'in value)return {...value,page:{...value.page,markdown:value.page.markdown.slice(0,12000)}}
  return value
 },{timeoutMs:10000,leaseMs:15000,fence:sourceFence(source),preflight:async(tx,workspace,deadline)=>{
  await authorize(tx,workspace,deadline)
  const row=(await tx.query('SELECT wake_tool_receipts FROM coordinator_events WHERE id=$1 AND "userId"=$2',[source.operationId,source.ownerId])).rows[0]
  cached=row.wake_tool_receipts?.[key]
  if(cached&&cached.binding!==binding)throw new QuotaError('webReceiptMismatch',409)
 },commit:async(tx,_reservation,value,workspace)=>{
  await authorize(tx,workspace,new Date())
  const row=(await tx.query('SELECT wake_tool_receipts FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE',[source.operationId,source.ownerId])).rows[0]
  const receipts=row.wake_tool_receipts??{}
  if(Object.keys(receipts).length>=128&&!receipts[key])throw new QuotaError('webReceiptLimit',409)
  // This domain result checkpoint is atomic with canonical quota settlement.
  await tx.query('UPDATE coordinator_events SET wake_tool_receipts=$3 WHERE id=$1 AND "userId"=$2',[source.operationId,source.ownerId,{...receipts,[key]:{binding,value}}])
 }})
 }catch(error){
  // Stable degradation only, never raw provider/auth/error strings in chat.
  if(error instanceof SearchProviderError)return {ok:false,error:'searchUnavailable',outcome:error.outcome}
  return {ok:false,error:'searchUnavailable',outcome:error instanceof ModelExecutionFailure&&error.statusCode===429||error instanceof QuotaError&&error.status===429?'rate_limited':error instanceof ModelExecutionFailure&&error.statusCode&&error.statusCode>=500?'upstream_error':error instanceof ModelExecutionFailure&&error.message==='modelResponseTimeout'?'timeout':'error'}
 }
}
