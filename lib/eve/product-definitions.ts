import 'server-only'
import { asSchema, type ToolSet } from 'ai'
import type { AgentExecution } from '../agent-kit/store'
import { requiresEveProductApproval } from './approval-bridge'
import { snapshotMailboxTools } from '../personal-mailbox-capability'
import type { EveScope } from './scope'
import type { ProductCatalogueEntry } from './product-rpc'

type Scope = EveScope
type ExecutionBinding = { sessionId: string; turnId: string; executionId?: string | null }

export async function asProductPrincipal<T>(scope: Scope, work: () => Promise<T>) {
  const { actAs } = await import('../acting-user')
  const { tokenWorkspace } = await import('../tokens/principal')
  return actAs({ id: scope.ownerId, [tokenWorkspace]: scope.workspaceId }, work)
}

/** Eve's dynamic definitions run in Node and use the product's existing stores. */
export async function prepareEveExecution(scope: Scope, sessionId: string, turnId: string) {
  const { assertSessionScope } = await import('./scope')
  await assertSessionScope(scope, sessionId)
  return asProductPrincipal(scope, () => beginProductExecution(scope, sessionId, turnId))
}

export async function beginProductExecution(scope: Scope, sessionId: string, turnId: string) {
  const kit = await import('../../workflows/coordinator/agent-kit-steps')
  const execution = await kit.beginAgentExecution(scope.ownerId, scope.botId, `${sessionId}:${turnId}`, 0, { harness: 'ai_sdk' })
  return { execution, runtime: execution?.snapshot.runtime ?? await kit.botRuntime(scope.ownerId, scope.botId) }
}

export const describeProductTools = (tools: ToolSet): Promise<ProductCatalogueEntry[]> => Promise.all(
  Object.entries(tools).map(async ([name, definition]) => ({
    name, description: typeof definition.description === 'string' ? definition.description : name, inputSchema: await asSchema(definition.inputSchema).jsonSchema,
    needsApprovalReview: requiresEveProductApproval(name),
  })),
)

/** Refresh discovery before each native model call. Execution rechecks every action. */
export async function productCatalogue(scope: Scope, binding: ExecutionBinding): Promise<ProductCatalogueEntry[]> {
  const { assertSessionScope } = await import('./scope')
  await assertSessionScope(scope, binding.sessionId)
  return asProductPrincipal(scope, async () => {
    const { execution, sourceEventId, scheduledRead, taskEventId, entryOrigin } = await productContext(scope, binding)
    const tools = await productTools(scope, execution, sourceEventId, scheduledRead, taskEventId, entryOrigin)
    return describeProductTools(tools)
  })
}

async function gatewayExecution(scope: Scope, input: ExecutionBinding): Promise<AgentExecution | null> {
  const { agentKitEnabled, agentKitStore, agentScope } = await import('../agent-kit/service')
  if (!input.executionId) {
    if (agentKitEnabled()) throw new Error('agentExecutionClosed')
    return null
  }
  return agentKitStore.readExecution(await agentScope(scope.ownerId, scope.botId), input.executionId, `${input.sessionId}:${input.turnId}:0`)
}

export async function productContext(scope: Scope, binding: ExecutionBinding) {
  const execution = await gatewayExecution(scope, binding)
  const { pool } = await import('../db')
  const source = (await pool.query<{ source_event_id: string; id: string | null; payload: Record<string, unknown> }>(`SELECT t.source_event_id,e.id,e.payload FROM eve_turn_sources t
    LEFT JOIN coordinator_events e ON e.id=t.source_event_id AND e."userId"=$3 AND e."botId"=$4
    WHERE t.session_id=$1 AND t.turn_id=$2`, [binding.sessionId, binding.turnId, scope.ownerId, scope.botId])).rows[0]
  if (source && !source.id) throw new Error('notFound')
  const sourceEventId = source?.source_event_id
  const requestSource = source ? await (await import('./retry-source')).eveOriginalRequestSource(scope, source.source_event_id, source.payload) : undefined
  const taskEventId = requestSource ? await (await import('./retry-source')).eveTaskRequestSource(scope, requestSource.id, requestSource.payload) : undefined
  const scheduledRead = sourceEventId ? await (await import('./scheduled-read')).loadScheduledRead(scope, sourceEventId) : null
  const entryOrigin = (await import('./run-origin')).eveRunOrigin(scope.surface, requestSource?.payload, Boolean(scheduledRead))
  return { execution, sourceEventId, scheduledRead, taskEventId, entryOrigin }
}

export async function productTools(scope: Scope, execution: AgentExecution | null, sourceEventId: string | undefined, scheduledRead: import('../schedules/contract').ScheduledRead | null, taskEventId: string | undefined,entryOrigin:import('../run-origin').ResolvedRunOrigin): Promise<ToolSet> {
  const steps = await import('../../workflows/coordinator/steps')
  const { coordinatorTools, readCoordinatorSwitches } = await import('../../workflows/coordinator/tools')
  const mailboxEnabled = !scheduledRead && snapshotMailboxTools(execution?.snapshot).length > 0 && await steps.mailboxToolsEnabled()
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
