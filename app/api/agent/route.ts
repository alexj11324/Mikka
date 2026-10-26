import { pool } from '@/lib/db'
import { subscriptionRepositoryIfInstalled } from '@/lib/subscription-binding-discovery'
import { mailboxes } from '@/lib/mailbox-runtime'
import { MAILBOX_INSTRUCTIONS, mailboxTools } from '@/lib/mailbox-tools'
import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream } from 'ai'
import { agentWebInstructions, createAgentWebTools } from '@/lib/agent-web-tools'
import { createComposioAITools } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import systemPrompt from '@/lib/agent-system-prompt.json'
import { validateAgentStream } from '@/lib/agent-fetch'
import { agentStatusStream } from '@/lib/agent-status'
import { persistAgentStream } from '@/lib/agent-history'
import { AgentStoreError, beginAgentTurn, saveAgentTurn } from '@/lib/agent-store'
import { createCredentialAITools } from '@/lib/credentials/ai-tools'
import { executeSystemCredentialTool } from '@/lib/credentials/runtime'
import { agentModelSourceSchema, resolveAgentModel } from '@/lib/agent-model'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from '@/lib/subscription-runtime'
import { resolveAgentSubscription } from '@/lib/agent-subscription'

export const maxDuration = 300

// Reuse the POST bundle: image lookup must not trigger a second cold route compilation.
export { GET } from './images/route'

const promptSchema = z.object({ prompt: z.string().trim().min(1).max(8000), sessionId: z.uuid().optional(), turnId: z.uuid().optional(), retry: z.boolean().optional(), modelSource: agentModelSourceSchema.optional() }).strict()
const errorHeaders = { 'Cache-Control': 'private, no-store', 'Content-Type': 'text/plain; charset=utf-8' }

function agentErrorMessage(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined
  if (status === 401 || status === 403) return agentCopy.opencodeGoAuthenticationOrModelAccessFailed
  if (status === 429 || status === 402) return agentCopy.opencodeGoIsRateLimitedOrOut
  if (error instanceof Error && /timeout|abort/i.test(error.name)) return agentCopy.theModelTimedOutReceivedContentIs
  return agentCopy.opencodeGoConnectionFailedReceivedContentIs
}

export async function HEAD(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  return new Response(null, { status: session?.user ? 204 : 401, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return new Response(agentCopy.crosssiteRequestsAreNotAllowed, { status: 403, headers: errorHeaders })
  }
  const startedAt = performance.now()
  const session = await auth.api.getSession({ headers: request.headers })
  const authenticatedAt = performance.now()
  if (!session?.user) return new Response(agentCopy.signInBeforeUsingAgent, { status: 401, headers: errorHeaders })
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return new Response(agentCopy.sendAJSONRequest, { status: 415, headers: errorHeaders })
  }
  if (Number(request.headers.get('content-length')) > 40000) {
    return new Response(agentCopy.theRequestIsTooLong, { status: 413, headers: errorHeaders })
  }
  const reader = request.body?.getReader()
  if (!reader) return new Response(agentCopy.enterAQuestion, { status: 400, headers: errorHeaders })
  let size = 0
  const decoder = new TextDecoder()
  let body = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 40000) {
        await reader.cancel()
        return new Response(agentCopy.theRequestIsTooLong, { status: 413, headers: errorHeaders })
      }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
  } catch {
    return new Response(agentCopy.unableToReadTheRequestPleaseRetry, { status: 400, headers: errorHeaders })
  } finally {
    reader.releaseLock()
  }
  const parsed = promptSchema.safeParse((() => {
    try { return JSON.parse(body) } catch { return null }
  })())
  if (!parsed.success) return new Response(agentCopy.enterAQuestionBetween1And8000, { status: 400, headers: errorHeaders })

  const sessionId = parsed.data.sessionId ?? crypto.randomUUID()
  const turnId = parsed.data.turnId ?? crypto.randomUUID()
  let model: Awaited<ReturnType<typeof resolveAgentModel>>
  let modelSource = parsed.data.modelSource
  try {
    if (!modelSource) {
      const saved = await (await subscriptionRepositoryIfInstalled(pool))?.defaultModelBinding(session.user.id, sessionId)
      if (saved) modelSource = { type: 'subscription', bindingId: saved }
    }
    model = await resolveAgentModel(modelSource, {
      subscriptionModel: async bindingId => {
        return resolveAgentSubscription(session.user.id, sessionId, bindingId, subscriptionRuntime(), authorizeSubscriptionWorkspace, request.signal)
      },
      defaultModel: () => {
        const apiKey = process.env.OPENCODE_API_KEY
        if (!apiKey) throw new Error('default_model_unavailable')
        const opencode = createOpenAICompatible({
          name: 'opencode', apiKey, baseURL: 'https://opencode.ai/zen/go/v1',
          headers: { 'User-Agent': 'Mikka-UI-Agent/1.0', 'x-opencode-session': sessionId },
        })
        return opencode('deepseek-v4.1-flash')
      },
    })
  } catch (error) {
    if (error instanceof SubscriptionRefusal) return Response.json({ error: error.code }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } })
    if (modelSource) return Response.json({ error: 'backend_unavailable' }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } })
    return new Response(agentCopy.opencodeapikeyIsNotConfiguredOnTheServer, { status: 503, headers: errorHeaders })
  }
  let turn: Awaited<ReturnType<typeof beginAgentTurn>>
  try {
    turn = await beginAgentTurn(session.user.id, sessionId, turnId, parsed.data.prompt, parsed.data.retry)
  } catch (error) {
    return new Response(error instanceof AgentStoreError ? error.message : agentCopy.unableToSaveThisQuestionPleaseTry, {
      status: error instanceof AgentStoreError ? error.status : 503, headers: errorHeaders,
    })
  }
  const messages: { role: 'user' | 'assistant'; content: string }[] = []
  let historySize = 0
  for (const previous of [...turn.history].reverse()) {
    historySize += previous.prompt.length + previous.completion.length
    if (historySize > 80000) break
    messages.unshift({ role: 'user', content: previous.prompt }, { role: 'assistant', content: previous.completion })
  }
  messages.push({ role: 'user', content: parsed.data.prompt })

  // A transient mailbox failure must not strand a saved pending Bot turn.
  // As with older worker assignments, advertise only available capabilities.
  const mailboxActor = await mailboxes.conversation(session.user.id, 'bot', sessionId).catch(() => {
    console.error('Could not prepare Bot mailbox; continuing without mailbox tools')
    return null
  })
  const generationError = modelSource ? () => 'Subscription connection unavailable.' : agentErrorMessage
  const result = streamText({
    model,
    providerOptions: { opencode: { reasoningEffort: 'medium' } },
    system: `${systemPrompt}\n\n${agentWebInstructions()}\n\n${mailboxActor ? MAILBOX_INSTRUCTIONS : ''}`,
    messages,
    tools: {
      ...createCredentialAITools((name, input) => executeSystemCredentialTool({ userId: session.user.id }, name, input)),
      ...(mailboxActor ? mailboxTools(mailboxes, mailboxActor) : {}),
      ...createAgentWebTools({ signal: request.signal }),
      ...createComposioAITools((action, input) => runComposioAction(session.user.id, action, input)),
    },
    stopWhen: isStepCount(5),
    prepareStep: ({ stepNumber }) => stepNumber >= 4 ? { toolChoice: 'none' } : {},
    maxRetries: modelSource ? 0 : 1,
    timeout: { totalMs: 270000, firstChunkMs: 120000, chunkMs: 90000 },
    abortSignal: request.signal,
    onError: ({ error }) => {
      if (!request.signal.aborted) console.error('Agent generation failed:', generationError(error))
    },
  })
  return createUIMessageStreamResponse({
    headers: {
      'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no', 'X-Agent-Session-Id': sessionId, 'X-Agent-Turn-Id': turnId,
      'Server-Timing': `auth;dur=${(authenticatedAt - startedAt).toFixed(1)}, prepare;dur=${(performance.now() - authenticatedAt).toFixed(1)}`,
    },
    stream: persistAgentStream(toUIMessageStream({
      stream: result.stream,
      sendReasoning: false,
      onError: generationError,
    }).pipeThrough(agentStatusStream({ startedAt, turnId })).pipeThrough(validateAgentStream()), checkpoint => saveAgentTurn(session.user.id, sessionId, turnId, turn.attemptId, checkpoint), request.signal),
  })
}
