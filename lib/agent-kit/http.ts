import { z } from 'zod'
import { agentDefinitionSchema, exportDefinition, importDefinition, MAX_DEFINITION_BYTES, type AgentDefinition } from './definition'
import { AgentKitError, type AgentKitStore, type AgentScope } from './store'
import { writePolicySettingsSchema, type createWritePolicySettings } from '@/lib/operations/write-policy-settings'

const version = z.number().int().positive()
const requestId = z.uuid()
const commandSchema = z.discriminatedUnion('action',[
  z.strictObject({ action:z.literal('set_workspace_write_policy'),permissions:writePolicySettingsSchema,expectedVersion:z.string().regex(/^(0|[1-9]\d*)$/) }),
  z.strictObject({ action:z.literal('set_write_policy'),permissions:writePolicySettingsSchema,expectedVersion:z.string().regex(/^(0|[1-9]\d*)$/) }),
  z.strictObject({ action:z.literal('save'),definition:agentDefinitionSchema,expectedVersion:version,requestId }),
  z.strictObject({ action:z.literal('import'),document:z.unknown(),expectedVersion:version,requestId }),
  z.strictObject({ action:z.literal('rollback'),targetVersionId:z.uuid(),expectedVersion:version,requestId }),
  z.strictObject({ action:z.literal('propose'),expectedVersion:version,requestId }),
  z.strictObject({ action:z.literal('evaluate'),proposalId:z.uuid(),requestId,mode:z.enum(['fixture','live']),consentToModelUsage:z.boolean() }),
  z.strictObject({ action:z.literal('approve'),proposalId:z.uuid(),evaluationId:z.uuid(),expectedVersion:version,requestId,confirm:z.literal(true) }),
  z.strictObject({ action:z.literal('reject'),proposalId:z.uuid() }),
])
const scopeId = z.union([z.literal('coordinator'),z.uuid()])
const response = (body: unknown,status=200) => Response.json(body,{ status,headers:{ 'Cache-Control':'private, no-store' } })

export async function boundedJSON(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AgentKitError('agentJSONRequired',415)
  const limit=MAX_DEFINITION_BYTES+4096
  const declared=request.headers.get('content-length')
  if (declared && Number(declared)>limit) throw new AgentKitError('agentDefinitionTooLarge',413)
  const reader=request.body?.getReader()
  if (!reader) throw new AgentKitError('agentCommandInvalid',400)
  const chunks:Uint8Array[]=[];let size=0
  try {
    while (true) {
      const chunk=await reader.read();if (chunk.done) break
      size+=chunk.value.byteLength
      if (size>limit) { await reader.cancel();throw new AgentKitError('agentDefinitionTooLarge',413) }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const body=new Uint8Array(size);let offset=0
  for (const chunk of chunks) {body.set(chunk,offset);offset+=chunk.byteLength}
  return JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(body))
}

export function createAgentDefinitionHandler(deps: {
  enabled:() => boolean
  authenticate:(request:Request) => Promise<string | null>
  scope:(ownerId:string,botId:string | null) => Promise<AgentScope>
  store:AgentKitStore
  writePolicy?: { enabled: () => boolean; settings: ReturnType<typeof createWritePolicySettings> }
  defaults:AgentDefinition
  evaluate:(scope:AgentScope,proposalId:string,requestId:string,mode:'fixture'|'live') => Promise<unknown>
}) {
  return async (request:Request,botId:string):Promise<Response> => {
    if (!deps.enabled()) return response({ error:'notEnabled' },404)
    if (!['GET','POST'].includes(request.method)) return response({ error:'methodNotAllowed' },405)
    if (request.method==='POST' && request.headers.get('origin')!==new URL(request.url).origin) return response({ error:'originMismatch' },403)
    try {
      const ownerId=await deps.authenticate(request)
      if (!ownerId) return response({ error:'authRequired' },401)
      const parsedId=scopeId.safeParse(botId)
      if (!parsedId.success) return response({ error:'agentScopeNotFound' },404)
      const scope=await deps.scope(ownerId,botId==='coordinator' ? null : botId)
      if (request.method==='GET') {
        const url=new URL(request.url)
        const view=url.searchParams.get('view') ?? 'active'
        if (view==='workspace_write_policy') {
          if (!deps.writePolicy?.enabled()) return response({ error:'notEnabled' },404)
          return response(await deps.writePolicy.settings.readWorkspace(scope))
        }
        if (view==='write_policy') {
          if (!deps.writePolicy?.enabled()) return response({ error:'notEnabled' },404)
          return response(await deps.writePolicy.settings.read(scope))
        }
        if (view==='history') return response({ versions:await deps.store.history(scope) })
        if (view==='dataset') return response({ cases:await deps.store.dataset(scope) })
        if (view==='proposals') return response({ proposals:await deps.store.proposals(scope) })
        if (view==='execution') {
          const id=z.uuid().parse(url.searchParams.get('id'))
          return response(await deps.store.readExecution(scope,id))
        }
        if (!['active','export'].includes(view)) return response({ error:'agentViewInvalid' },400)
        const current=await deps.store.active(scope,deps.defaults)
        if (view==='export') return new Response(exportDefinition(current.definition),{ headers:{ 'Content-Type':'application/json','Content-Disposition':'attachment; filename="agent.json"','Cache-Control':'private, no-store' } })
        return response(current)
      }
      const command=commandSchema.parse(await boundedJSON(request))
      switch(command.action) {
        case 'set_workspace_write_policy':
          if (!deps.writePolicy?.enabled()) return response({ error:'notEnabled' },404)
          return response(await deps.writePolicy.settings.setWorkspace(scope,command.permissions,command.expectedVersion))
        case 'set_write_policy':
          if (!deps.writePolicy?.enabled()) return response({ error:'notEnabled' },404)
          return response(await deps.writePolicy.settings.set(scope,command.permissions,command.expectedVersion))
        case 'save':return response(await deps.store.save(scope,command.definition,command.expectedVersion,command.requestId,deps.defaults))
        case 'import':return response(await deps.store.save(scope,importDefinition(command.document),command.expectedVersion,command.requestId,deps.defaults))
        case 'rollback':return response(await deps.store.rollback(scope,command.targetVersionId,command.expectedVersion,command.requestId,deps.defaults))
        case 'propose':return response(await deps.store.propose(scope,command.expectedVersion,command.requestId,deps.defaults),201)
        case 'evaluate':
          if (command.mode==='live' && !command.consentToModelUsage) return response({ error:'agentModelUsageConsentRequired' },400)
          return response(await deps.evaluate(scope,command.proposalId,command.requestId,command.mode))
        case 'approve':return response(await deps.store.approve(scope,command.proposalId,command.evaluationId,command.expectedVersion,command.requestId,deps.defaults))
        case 'reject':return response(await deps.store.reject(scope,command.proposalId))
      }
    } catch(error) {
      if (error instanceof AgentKitError) return response({ error:error.code },error.status)
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) return response({ error:'agentCommandInvalid' },400)
      if (error instanceof Error && ['agentDefinitionChecksumMismatch','agentDefinitionTooLarge'].includes(error.message)) return response({ error:error.message },400)
      // Neither database diagnostics nor provider/credential details belong in an API response.
      return response({ error:'agentKitUnavailable' },500)
    }
  }
}
