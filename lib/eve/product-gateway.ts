import 'server-only'
import { asSchema, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentExecution } from '../agent-kit/store'

const id = z.string().min(1).max(256)
const common = { sessionId: id, turnId: id, executionId: z.uuid().nullable().optional() }
const toolCall = { ...common, name: z.string().min(1).max(128), input: z.unknown(), callId: id }
const approvalResponder = z.object({
  authenticator: z.literal('mikka'), principalType: z.literal('user'), principalId: id,
  attributes: z.object({ botId: z.uuid(), workspaceId: z.uuid(), surface: z.enum(['web', 'slack']) }).strict(),
}).strict()
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ ...common, operation: z.literal('prepare') }).strict(),
  z.object({ ...common, operation: z.literal('instructions') }).strict(),
  z.object({ ...common, operation: z.literal('catalogue') }).strict(),
  z.object({ ...toolCall, operation: z.literal('approval') }).strict(),
  z.object({ ...toolCall, operation: z.literal('execute'), approvalResponder: approvalResponder.optional() }).strict(),
  z.object({ ...common, operation: z.literal('finish'), outcome: z.enum(['completed', 'failed', 'cancelled']), messages: z.array(z.unknown()).optional() }).strict(),
])
type Input = z.infer<typeof requestSchema>
type Scope = { ownerId: string; botId: string; workspaceId: string; surface: 'web' | 'slack' }

/** Test seam is the authenticated product boundary, independent of eve's model/tool loop. */
export interface EveProductGatewayServices {
  authorize(request: Request): Promise<Scope | null>
  assertSession(scope: Scope, sessionId: string): Promise<void>
  run(scope: Scope, input: Input, signal: AbortSignal, authorization: string | null): Promise<unknown>
}

async function boundedBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 512 * 1024) throw new Error('validationGeneric')
      chunks.push(chunk.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch (error) { throw new Error('validationGeneric', { cause: error }) }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

/** Product tools must run in the Mikka host's Workflow world, not eve's independent world. */
export async function handleEveProductRequest(request: Request, services: EveProductGatewayServices = defaultServices) {
  try {
    const scope = await services.authorize(request)
    if (!scope) return Response.json({ error: 'authRequired' }, { status: 401 })
    const parsed = requestSchema.safeParse(await boundedBody(request))
    if (!parsed.success) return Response.json({ error: 'validationGeneric' }, { status: 400 })
    await services.assertSession(scope, parsed.data.sessionId)
    const result = await services.run(scope, parsed.data, request.signal, request.headers.get('authorization'))
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    // Raw tool/provider/SQL errors can contain credentials or user content.
    const code = error instanceof Error ? error.message : ''
    const denied = ['authRequired', 'notFound', 'workspaceAccessDenied', 'botNotFound', 'agentExecutionClosed', 'scheduleReadAuthorityLost'].includes(code)
    return Response.json({ error: code === 'validationGeneric' ? code : denied ? 'notFound' : 'failed' }, { status: code === 'validationGeneric' ? 400 : denied ? 404 : 503 })
  }
}

const defaultServices: EveProductGatewayServices = {
  async authorize(request) {
    const { internalEveScope } = await import('./auth')
    return internalEveScope(request.headers.get('authorization'))
  },
  async assertSession(scope, sessionId) {
    const { assertSessionScope } = await import('./scope')
    await assertSessionScope(scope, sessionId)
  },
  async run(scope, input, signal, authorization) {
    const { actAs } = await import('../acting-user')
    const { tokenWorkspace } = await import('../tokens/principal')
    return actAs({ id: scope.ownerId, [tokenWorkspace]: scope.workspaceId }, async () => {
      const kit = await import('../../workflows/coordinator/agent-kit-steps')
      if (input.operation === 'prepare') {
        const execution = await kit.beginAgentExecution(scope.ownerId, scope.botId, `${input.sessionId}:${input.turnId}`, 0, { harness: 'ai_sdk' })
        return { execution, runtime: execution?.snapshot.runtime ?? await kit.botRuntime(scope.ownerId, scope.botId) }
      }
      if (input.operation === 'finish') {
        const { finishEveTurn } = await import('./settlement')
        return finishEveTurn(scope, input)
      }
      const execution = await gatewayExecution(scope, input)
      const { pool } = await import('../db')
      const source = (await pool.query<{ source_event_id: string; id: string | null; payload: Record<string, unknown> }>(`SELECT t.source_event_id,e.id,e.payload FROM eve_turn_sources t
        LEFT JOIN coordinator_events e ON e.id=t.source_event_id AND e."userId"=$3 AND e."botId"=$4
        WHERE t.session_id=$1 AND t.turn_id=$2`, [input.sessionId, input.turnId, scope.ownerId, scope.botId])).rows[0]
      if (source && !source.id) throw new Error('notFound')
      const sourceEventId = source?.source_event_id
      const requestSource = source ? await (await import('./retry-source')).eveOriginalRequestSource(scope,source.source_event_id,source.payload) : undefined
      const taskEventId = requestSource ? await (await import('./retry-source')).eveTaskRequestSource(scope,requestSource.id,requestSource.payload) : undefined
      const scheduledRead = sourceEventId ? await (await import('./scheduled-read')).loadScheduledRead(scope, sourceEventId) : null
      const entryOrigin = (await import('./run-origin')).eveRunOrigin(scope.surface,requestSource?.payload,Boolean(scheduledRead))
      if (input.operation === 'instructions') {
        if (scheduledRead) return { instructions: `This is a scheduled read-only task. Use only its allowed read tools, perform no writes and request no approval.\n${scheduledRead.prompt}` }
        if (scope.surface === 'slack') {
          const { COORDINATOR_INSTRUCTIONS } = await import('../coordinator/instructions')
          return { instructions: COORDINATOR_INSTRUCTIONS + '\nUse only this Slack conversation. Do not access private web conversation history, memories or profile. Reply in this thread, or call no_reply when no useful response is needed.' }
        }
        const { prepareEveInstructions } = await import('../../workflows/coordinator/steps')
        return { instructions: await prepareEveInstructions(scope.ownerId, scope.botId, execution?.snapshot, { sessionId: input.sessionId, turnId: input.turnId }) }
      }
      const tools = await productTools(scope, execution, sourceEventId, scheduledRead, taskEventId,entryOrigin)
      if (input.operation === 'catalogue') {
        return { tools: await Promise.all(Object.entries(tools).map(async ([name, definition]) => ({ name, description: definition.description ?? name, inputSchema: await asSchema(definition.inputSchema).jsonSchema }))) }
      }
      const tool = Object.hasOwn(tools, input.name) ? tools[input.name] : undefined
      if (!tool?.execute) throw new Error('notFound')
      const validator = asSchema(tool.inputSchema).validate
      if (!validator) throw new Error('validationGeneric')
      const checked = await validator(input.input)
      if (!checked.success) throw new Error('validationGeneric')
      signal.throwIfAborted()
      const { withEveProductAuthority } = await import('../enterprise/execution-authority')
      const output = await withEveProductAuthority(authorization, input, async () => {
        const call = { ...scope, sessionId: input.sessionId, turnId: input.turnId, executionId: input.executionId, sourceEventId, name: input.name, input: checked.value, callId: input.callId }
        const { reviewEveProductApproval, executeEveApprovedWrite } = await import('./product-approval')
        if (input.operation === 'approval') return reviewEveProductApproval(call, signal)
        const approved = await executeEveApprovedWrite(call, input.approvalResponder, signal)
        if (approved) return approved.output
        return tool.execute!(checked.value, { toolCallId: input.callId, messages: [], context: {}, abortSignal: signal })
      })
      if (input.operation === 'approval') return output
      const { maskDeep, credentialMasker } = await import('../secrets/mask')
      const safe = maskDeep(output, credentialMasker)
      await (await import('../credentials/chat-guard')).assertCredentialSafeChat(scope.ownerId, safe)
      return { output: safe }
    })
  },
}

async function gatewayExecution(scope: Scope, input: Input): Promise<AgentExecution | null> {
  const { agentKitEnabled, agentKitStore, agentScope } = await import('../agent-kit/service')
  if (!input.executionId) {
    if (agentKitEnabled()) throw new Error('agentExecutionClosed')
    return null
  }
  const { pool } = await import('../db')
  const found = await pool.query(`SELECT 1 FROM agent_kit_executions WHERE id=$1 AND owner_id=$2 AND bot_key=$3 AND execution_key=$4 AND status='running'`,
    [input.executionId, scope.ownerId, scope.botId, `${input.sessionId}:${input.turnId}:0`])
  if (!found.rowCount) throw new Error('agentExecutionClosed')
  return agentKitStore.readExecution(await agentScope(scope.ownerId, scope.botId), input.executionId)
}

async function productTools(scope: Scope, execution: AgentExecution | null, sourceEventId: string | undefined, scheduledRead: import('../schedules/contract').ScheduledRead | null, taskEventId: string | undefined,entryOrigin:import('../run-origin').ResolvedRunOrigin): Promise<ToolSet> {
  const steps = await import('../../workflows/coordinator/steps')
  const { coordinatorTools, readCoordinatorSwitches } = await import('../../workflows/coordinator/tools')
  const mailboxEnabled = !scheduledRead && await steps.mailboxToolsEnabled()
  const tools = coordinatorTools(scope.ownerId, scope.botId, scheduledRead ? { scheduledRead: { botId: scope.botId, occurrence: scheduledRead } } : undefined, {
    execution, sourceEventId, ...(taskEventId ? { taskEventId } : {}),...entryOrigin,
    switches: readCoordinatorSwitches(), coordinator: await steps.isCoordinatorChat(scope.ownerId, scope.botId),
    computerEnabled: !scheduledRead && await steps.computerToolsEnabled(), writeEnabled: !scheduledRead && await steps.personalWriteToolsEnabled(),
    mailboxEnabled, mailboxTools: mailboxEnabled ? await steps.mailboxCatalogue(scope.ownerId, scope.botId, execution?.id) : [],
    ...(scheduledRead ? { readOnly: true, readToolIds: scheduledRead.allowedActions } : {}),
  })
  // Discovery, skills and generic MCP execution belong to eve's native capabilities.
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !['load_skill', 'read_personal_skill', 'list_personal_mcp_tools', 'call_personal_mcp_tool'].includes(name)))
}
