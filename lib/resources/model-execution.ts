import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { QuotaStore, beginQuotaWith, type Reservation } from '../quota/store'
import { QuotaError, quotaFailure } from '../quota/errors'
import {appendAudit,transaction} from '../audit/store'
import {admitModel,PolicyError} from '../policy/contract'
import {randomUUID} from 'node:crypto'
import type { PolicyStore } from '../policy/store'
import type { ModelRoute } from '../policy/contract'
import type { PolicyClient } from '../policy/sql-client'

/** Private to this composition: no public positive policy gate can be called
 * without the canonical quota/source-fence path below. #279's existing
 * authorizeModelRequest remains unchanged and fail-closed without an adapter. */
async function withReservedModel<T>(store:PolicyStore,userId:string,workspaceId:string,route:ModelRoute,work:(tx:PolicyClient)=>Promise<T>):Promise<T>{
 const result=await transaction(store.pool,async tx=>{
  let resourceId='model'
  try{
   await store.member(tx,workspaceId,userId)
   const bindings=await store.bindings(tx,userId,workspaceId,undefined,true)
   for(const binding of bindings){
    resourceId=binding.signed.payload.hash
    if(binding.revoked)throw new PolicyError('policyRevoked',403)
    admitModel(binding.effective,route)
   }
   return {value:await work(tx)}
  }catch(error){
   await appendAudit(tx,workspaceId,{actorId:userId,actorType:'system',resourceId,action:'policy.model',outcome:'denied',reason:error instanceof PolicyError?error.code:'modelExecutionUnavailable',requestId:randomUUID()})
   return {error}
  }
 })
 if('error'in result)throw result.error
 return result.value
}

/** Constructed from a persisted domain operation, never caller-selected scope. */
export type ModelExecutionScope = {
  ownerId: string
  workspaceId: string
  operationId: string
  generation: number
  stepKey: string
  resource: 'coordinator.model' | 'coordinator.compact' | 'gateway.decision' | 'schedule.model' | 'web.search' | 'web.scrape'
  binding: unknown
}
export type ModelSourceFence = (tx: PoolClient, reservation: Reservation, deadline: Date, workspace: PolicyClient) => Promise<void>
export class ModelExecutionFailure extends Error{
  constructor(readonly outcome:'unsent'|'rejected'|'uncertain',code:string,readonly retryAfter?:number,readonly statusCode?:number){super(code);this.name='ModelExecutionFailure'}
}

function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function aborted(signal: AbortSignal) { signal.throwIfAborted() }
async function bounded<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  aborted(signal)
  let listener: () => void = () => {}
  const timeout = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
  })
  try { return await Promise.race([value, timeout]) }
  finally { signal.removeEventListener('abort', listener) }
}
async function responseBody(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.body) return response
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0, complete = false
  try {
    while (true) {
      const result = await bounded(reader.read(), signal)
      if (result.done) { complete = true; break }
      size += result.value.byteLength
      if (size > 16 * 1024 * 1024) throw new Error('modelResponseTooLarge')
      chunks.push(result.value)
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers })
  } finally {
    // A broken transport may ignore cancellation; cleanup cannot hold the deadline.
    if (!complete) void reader.cancel().catch(() => {})
  }
}

/** One canonical quota engine; policy locks and existing domain fences protect
 * the actual SDK fetch. Neither quota nor this adapter caches model results. */
export class ResourceModelExecution {
  constructor(private app: Pool, private policy: PolicyStore, private send: typeof fetch = fetch) {}
  async available(scope: Pick<ModelExecutionScope,'ownerId'|'workspaceId'|'resource'>,route:ModelRoute){
    return withReservedModel(this.policy,scope.ownerId,scope.workspaceId,route,async workspace=>{
      const quota=new QuotaStore(this.app,async(owner,id)=>{
        if(id!==scope.workspaceId||owner!==scope.ownerId)return false
        await this.policy.member(workspace,id,owner)
        return true
      })
      return quota.inspect(scope.ownerId,scope.workspaceId,scope.resource)
    })
  }
  async run<T>(scope: ModelExecutionScope, route: ModelRoute, invoke: ResourceInvoke<T>, options: ResourceOptions<T>) {
    return this.execute(scope,invoke,options,work=>withReservedModel(this.policy,scope.ownerId,scope.workspaceId,route,work),route)
  }
  /** Same canonical reservation/send/settle path, with the existing tool policy
   * gate. A service cache hit or persisted receipt consumes no provider quota. */
  async runTool<T>(scope:ModelExecutionScope,invoke:ResourceInvoke<T>,options:ResourceOptions<T>&{
    preflight:(tx:PoolClient,workspace:PolicyClient,deadline:Date)=>Promise<void>
  }){
    if(!['web.search','web.scrape'].includes(scope.resource))throw new QuotaError('modelScopeMismatch',403)
    return this.execute(scope,invoke,options,work=>this.policy.withTool(scope.ownerId,work,[scope.workspaceId]))
  }
  private async execute<T>(scope:ModelExecutionScope,invoke:ResourceInvoke<T>,options:ResourceOptions<T>,
    admit:(work:(workspace:PolicyClient)=>Promise<T>)=>Promise<T>,route?:ModelRoute){
    if (!scope.workspaceId || !scope.ownerId || !scope.operationId || !scope.stepKey || !Number.isSafeInteger(scope.generation) || scope.generation < 0)
      throw new QuotaError('modelScopeUnavailable', 403)
    const timeoutMs = options.timeoutMs ?? 40000, leaseMs = options.leaseMs ?? 60000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 45000 || leaseMs <= timeoutMs || leaseMs > 300000)
      throw new QuotaError('modelDeadlineInvalid', 400)
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])])
    const deadline = new Date(Date.now() + timeoutMs)
    return admit(async workspace => {
      aborted(signal)
      const quotas = new QuotaStore(this.app, async (owner, id) => {
        if (id !== scope.workspaceId || owner !== scope.ownerId) return false
        await this.policy.member(workspace, id, owner)
        return true
      })
      const fence = async (tx:PoolClient, reservation:Reservation) => {
        if (reservation.workspace_id !== scope.workspaceId) throw new QuotaError('modelWorkspaceMismatch', 403)
        await options.fence(tx, reservation, deadline, workspace)
      }
      if(options.preflight)await transaction(this.app,tx=>options.preflight!(tx,workspace,deadline))
      const begin=()=>beginQuotaWith(quotas, { ownerId: scope.ownerId,
        key: `model:${scope.operationId}:${scope.generation}:${digest(scope.stepKey).slice(0,32)}`,
        resource: scope.resource, binding: { ...(route?{route}:{}), operation: scope.binding }, leaseMs }, fence)
      let reservation:Reservation|undefined=route?await begin():undefined
      let sent = false,transportError:unknown
      try {
        const guarded: typeof fetch = async (input, init) => {
          try{
            if (sent) throw new QuotaError('modelTransportRepeated', 409)
            const url = input instanceof Request ? input.url : String(input)
            if(typeof init?.body !== 'string')throw new QuotaError('modelTransportBindingMismatch',403)
            const payload = JSON.parse(init.body), headers = new Headers(init.headers)
            if(route){
              const model = route.provider === 'vercel_gateway' && headers.has('ai-language-model-id') ? headers.get('ai-language-model-id') : payload.model
              if(url!==route.endpoint||model!==route.model)throw new QuotaError('modelTransportBindingMismatch',403)
            }else{
              const endpoint=scope.resource==='web.search'?'search':'scrape'
              if(url!==`https://api.firecrawl.dev/v2/${endpoint}`||init.method!=='POST'||headers.has('cookie')||init.credentials!=='omit')throw new QuotaError('modelTransportBindingMismatch',403)
            }
            aborted(signal)
            reservation??=await begin()
            await quotas.revalidate(scope.ownerId, reservation.id, fence)
            aborted(signal)
            sent = true
            const requestSignal=AbortSignal.any([signal,...(init.signal?[init.signal]:[])])
            const response = await bounded(this.send(input, { ...init, signal:requestSignal, redirect: 'error' }), requestSignal)
            if (!response.ok) {
              void response.body?.cancel().catch(() => {})
              throw Object.assign(new Error('modelProviderRejected'), { statusCode: response.status, responseHeaders: { 'retry-after': response.headers.get('retry-after') } })
            }
            return await responseBody(response,requestSignal)
          }catch(error){transportError=error;throw error}
        }
        const result = await bounded(invoke(guarded, signal,workspace), signal)
        // SearchProvider deliberately degrades failures; it cannot erase an
        // actual network outcome or change whether canonical quota refunds.
        if(transportError)throw transportError
        if(!route&&sent&&(result as {ok?:boolean}).ok===false)throw new Error('webProviderInvalidResponse')
        if(route&&!sent)throw new Error('modelTransportMissing')
        if(reservation)await quotas.finish(scope.ownerId,reservation.id,'settled',options.usage?.(result),undefined,options.commit?(tx,row)=>options.commit!(tx,row,result,workspace):undefined)
        return result
      } catch (error) {
        if(!reservation)throw error
        const failure = sent ? quotaFailure(error) : { outcome: 'refunded' as const }
        const row=await quotas.finish(scope.ownerId, reservation.id, failure.outcome, undefined, failure.retryAfter)
        const outcome=row.state==='refunded'?(sent?'rejected':'unsent'):'uncertain'
        const code=error instanceof QuotaError?error.code:error instanceof Error&&/timeout|abort/i.test(error.name)?'modelResponseTimeout':outcome==='rejected'?'modelProviderRejected':outcome==='unsent'?'modelNotSent':'modelExecutionUncertain'
        throw new ModelExecutionFailure(outcome,code,failure.retryAfter,(error as {statusCode?:number})?.statusCode)
      }
    })
  }
}
type ResourceInvoke<T>=(send:typeof fetch,signal:AbortSignal,workspace:PolicyClient)=>Promise<T>
type ResourceOptions<T>={fence:ModelSourceFence;signal?:AbortSignal;timeoutMs?:number;leaseMs?:number;
 usage?:(value:T)=>{inputTokens?:number;outputTokens?:number};
 preflight?:(tx:PoolClient,workspace:PolicyClient,deadline:Date)=>Promise<void>;
 commit?:(tx:PoolClient,reservation:Reservation,value:T,workspace:PolicyClient)=>Promise<void>}
