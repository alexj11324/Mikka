import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createUIMessageStreamResponse, streamText, toUIMessageStream } from 'ai'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import systemPrompt from '@/lib/agent-system-prompt.json'
import { validateAgentStream } from '@/lib/agent-fetch'
import { persistAgentStream } from '@/lib/agent-history'
import { AgentStoreError, beginAgentTurn, saveAgentTurn } from '@/lib/agent-store'

export const maxDuration = 300

// Reuse the POST bundle: image lookup must not trigger a second cold route compilation.
export { GET } from './images/route'

const promptSchema = z.object({ prompt: z.string().trim().min(1).max(8000), sessionId: z.uuid().optional(), turnId: z.uuid().optional(), retry: z.boolean().optional() }).strict()
const errorHeaders = { 'Cache-Control': 'private, no-store', 'Content-Type': 'text/plain; charset=utf-8' }

function agentErrorMessage(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined
  if (status === 401 || status === 403) return 'OpenCode Go 身份验证或模型权限检查失败，请检查服务端配置。'
  if (status === 429 || status === 402) return 'OpenCode Go 当前限流或额度不足，请稍后重试并检查订阅额度。'
  if (error instanceof Error && /timeout|abort/i.test(error.name)) return '模型响应超时，已收到的内容已保留，请在此重试。'
  return 'OpenCode Go 连接失败，已有内容已保留，请在此重试。'
}

export async function HEAD(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  return new Response(null, { status: session?.user ? 204 : 401, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return new Response('不允许跨站调用。', { status: 403, headers: errorHeaders })
  }
  const startedAt = performance.now()
  const session = await auth.api.getSession({ headers: request.headers })
  const authenticatedAt = performance.now()
  if (!session?.user) return new Response('请先登录后再使用 Agent。', { status: 401, headers: errorHeaders })
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return new Response('请发送 JSON 格式的请求。', { status: 415, headers: errorHeaders })
  }
  if (Number(request.headers.get('content-length')) > 40000) {
    return new Response('请求内容过长。', { status: 413, headers: errorHeaders })
  }
  const reader = request.body?.getReader()
  if (!reader) return new Response('请输入问题。', { status: 400, headers: errorHeaders })
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
        return new Response('请求内容过长。', { status: 413, headers: errorHeaders })
      }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
  } catch {
    return new Response('无法读取请求，请重试。', { status: 400, headers: errorHeaders })
  } finally {
    reader.releaseLock()
  }
  const parsed = promptSchema.safeParse((() => {
    try { return JSON.parse(body) } catch { return null }
  })())
  if (!parsed.success) return new Response('请输入 1–8000 字的问题。', { status: 400, headers: errorHeaders })

  const apiKey = process.env.OPENCODE_API_KEY
  if (!apiKey) return new Response('服务端尚未配置 OPENCODE_API_KEY，请添加环境变量后重试。', { status: 503, headers: errorHeaders })

  const sessionId = parsed.data.sessionId ?? crypto.randomUUID()
  const turnId = parsed.data.turnId ?? crypto.randomUUID()
  let turn: Awaited<ReturnType<typeof beginAgentTurn>>
  try {
    turn = await beginAgentTurn(session.user.id, sessionId, turnId, parsed.data.prompt, parsed.data.retry)
  } catch (error) {
    return new Response(error instanceof AgentStoreError ? error.message : '无法保存本次提问，请稍后重试。', {
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

  const opencode = createOpenAICompatible({
    name: 'opencode',
    apiKey,
    baseURL: 'https://opencode.ai/zen/go/v1',
    headers: { 'User-Agent': 'Orvilo-UI-Agent/1.0', 'x-opencode-session': sessionId },
  })
  const result = streamText({
    model: opencode('deepseek-v4.1-flash'),
    providerOptions: { opencode: { reasoningEffort: 'medium' } },
    system: systemPrompt,
    messages,
    maxRetries: 1,
    timeout: { totalMs: 270000, firstChunkMs: 120000, chunkMs: 90000 },
    abortSignal: request.signal,
    onError: ({ error }) => {
      if (!request.signal.aborted) console.error('Agent generation failed:', agentErrorMessage(error))
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
      onError: agentErrorMessage,
    }).pipeThrough(validateAgentStream()), checkpoint => saveAgentTurn(session.user.id, sessionId, turnId, turn.attemptId, checkpoint), request.signal),
  })
}
