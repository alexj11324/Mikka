import 'server-only'
import { asSchema, type ToolSet } from 'ai'
import type { AgentExecution } from '../agent-kit/store'
import type { DefinitionSnapshot } from '../agent-kit/definition'
import type { HostedRuntimeSnapshot } from '../subscription-model-snapshot'
import type { ScheduledRead } from '../schedules/contract'
import { productRpc } from './product-rpc'
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

export const describeProductTools = (tools: ToolSet): Promise<ProductCatalogueEntry[]> => Promise.all(
  Object.entries(tools).map(async ([name, definition]) => ({
    name, description: typeof definition.description === 'string' ? definition.description : name, inputSchema: await asSchema(definition.inputSchema).jsonSchema,
    needsApprovalReview: requiresEveProductApproval(name),
  })),
)

/** Native discovery uses the Bot's business policy; actions resolve their own execution. */
export async function productCatalogue(scope: Scope, binding: Pick<ExecutionBinding, 'sessionId' | 'turnId'>,
  policy: Pick<DefinitionSnapshot, 'definition' | 'effectiveTools'> | null, runtime: HostedRuntimeSnapshot,
  request: { sourceEventId?: string; scheduledRead: ScheduledRead | null }): Promise<ProductCatalogueEntry[]> {
  return asProductPrincipal(scope, async () => {
    const steps = await import('../../workflows/coordinator/steps')
    const { coordinatorTools, coordinatorWriteCatalogue, readCoordinatorSwitches } = await import('../../workflows/coordinator/tools')
    const mailboxTools = snapshotMailboxTools(policy)
    const { scheduledRead, sourceEventId } = request
    const tools = coordinatorTools(scope.ownerId, scope.botId,
      scheduledRead ? { scheduledRead: { botId: scope.botId, occurrence: scheduledRead } } : undefined, {
        policy: policy ?? undefined, runtime, sourceEventId, switches: readCoordinatorSwitches(),
        coordinator: await steps.isCoordinatorChat(scope.ownerId, scope.botId),
        computerEnabled: !scheduledRead && await steps.computerToolsEnabled(),
        writeEnabled: Boolean(policy) && !scheduledRead && await steps.personalWriteToolsEnabled(),
        mailboxEnabled: !scheduledRead && mailboxTools.length > 0 && await steps.mailboxToolsEnabled(), mailboxTools,
        writeTools: { catalog: coordinatorWriteCatalogue, submit: async call => (await productRpc<{ output: unknown }>(scope, {
          ...binding, operation: 'execute', name: call.action, input: call.input, callId: call.toolCallId,
        })).output },
        ...(scheduledRead ? { readOnly: true, readToolIds: scheduledRead.allowedActions } : {}),
      })
    return describeProductTools(Object.fromEntries(Object.entries(tools).filter(([name]) =>
      !['load_skill', 'read_personal_skill', 'list_personal_mcp_tools', 'call_personal_mcp_tool'].includes(name))))
  })
}

/** Actual native actions allocate the existing business execution before calling the app. */
export async function beginProductAction(scope: Scope, input: Pick<ExecutionBinding, 'sessionId' | 'turnId'>): Promise<string | undefined> {
  return asProductPrincipal(scope, async () => {
    const { agentKitEnabled } = await import('../agent-kit/service')
    if (!agentKitEnabled()) return undefined
    const [{ pool }, { withDirectSession }] = await Promise.all([import('../db'), import('../db/direct-session')])
    return withDirectSession(pool, async client => {
      // Allocation and finish own the same turn, including a turn with no earlier action.
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`eve-settlement:${input.sessionId}:${input.turnId}`])
      const receipt = await client.query('SELECT 1 FROM eve_turn_settlements WHERE session_id=$1 AND turn_id=$2', [input.sessionId, input.turnId])
      if (receipt.rowCount) throw new Error('agentExecutionClosed')
      const { beginAgentExecution } = await import('../../workflows/coordinator/agent-kit-steps')
      const execution = await beginAgentExecution(scope.ownerId, scope.botId, `${input.sessionId}:${input.turnId}`, 0, { harness: 'ai_sdk' })
      if (!execution) throw new Error('agentExecutionClosed')
      return execution.id
    })
  })
}

async function productExecution(scope: Scope, input: ExecutionBinding): Promise<AgentExecution | null> {
  const { agentKitEnabled, agentKitStore, agentScope } = await import('../agent-kit/service')
  if (!input.executionId) {
    if (agentKitEnabled()) throw new Error('agentExecutionClosed')
    return null
  }
  return agentKitStore.readExecution(await agentScope(scope.ownerId, scope.botId), input.executionId, `${input.sessionId}:${input.turnId}:0`)
}

export async function productContext(scope: Scope, binding: ExecutionBinding) {
  const execution = await productExecution(scope, binding)
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
