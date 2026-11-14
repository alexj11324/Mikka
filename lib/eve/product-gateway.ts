import 'server-only'
import { asSchema } from 'ai'
import { z } from 'zod'
import type { EveScope } from './scope'
import { asProductPrincipal, beginProductExecution, describeProductTools, productContext, productTools } from './product-definitions'

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
type Scope = EveScope

/** Test seam is the authenticated product boundary, independent of eve's model/tool loop. */
export interface EveProductGatewayServices {
  authorize(request: Request): Promise<Scope | null>
  assertSession(scope: Scope, sessionId: string): Promise<void>
  run(scope: Scope, input: Input, signal: AbortSignal, request: Request): Promise<unknown>
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
    const result = await services.run(scope, parsed.data, request.signal, request)
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
    const { internalEveRequestScope } = await import('./auth')
    return internalEveRequestScope(request)
  },
  async assertSession(scope, sessionId) {
    const { assertSessionScope } = await import('./scope')
    await assertSessionScope(scope, sessionId)
  },
  async run(scope, input, signal, request) {
    return asProductPrincipal(scope, async () => {
      // Existing Eve releases can retain these callbacks during an API upgrade.
      if (input.operation === 'prepare') return beginProductExecution(scope, input.sessionId, input.turnId)
      if (input.operation === 'finish') {
        const { finishEveTurn } = await import('./settlement')
        return finishEveTurn(scope, input)
      }
      const { execution, sourceEventId, scheduledRead, taskEventId, entryOrigin } = await productContext(scope, input)
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
      if (input.operation === 'catalogue') return { tools: await describeProductTools(tools) }
      const tool = Object.hasOwn(tools, input.name) ? tools[input.name] : undefined
      if (!tool?.execute) throw new Error('notFound')
      const validator = asSchema(tool.inputSchema).validate
      if (!validator) throw new Error('validationGeneric')
      const checked = await validator(input.input)
      if (!checked.success) throw new Error('validationGeneric')
      signal.throwIfAborted()
      const { withEveProductAuthority } = await import('../enterprise/execution-authority')
      const output = await withEveProductAuthority(request, input, async () => {
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
