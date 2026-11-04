// Live acceptance/evaluation policy, not a restriction on users' model choices.
// API-key test runs use GPT-6 Luna or Claude Haiku 5.5. DeepSeek Flash stays
// allowed for existing drivers. Subscription cases keep their bound
// subscription. Never substitute Pro or another model for capacity, quota or
// retries.
const testModels = new Set([
  'gpt-6-luna', 'openai/gpt-6-luna', 'gpt-6-luna-decisions', 'openai/gpt-6-luna-decisions',
  'claude-haiku-5-5', 'claude-haiku-5.5', 'anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5.5',
  'deepseek-v4.1-flash', 'deepseek-flash', 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-flash',
])

export function assertFlashTestModel(model) {
  if (!testModels.has(model)) throw new Error('Test model policy: model is not GPT-6 Luna, Claude Haiku 5.5 or DeepSeek Flash; request blocked')
}

export const assertTestModel = assertFlashTestModel

/** Check the actual outgoing selection/model, before upstream fetch is called. */
export async function assertTestModelRequest(request) {
  const url = new URL(request.url)
  const selection = request.method === 'PUT' && url.pathname.endsWith('/api/mobile/model')
  const generation = request.method === 'POST' && /\/(?:chat\/completions|responses|v1\/messages|language-model)$/.test(url.pathname)
  if (!selection && !generation) return
  const body = await request.clone().json()
  if (selection) {
    const match = typeof body.id === 'string' && /^apikey:[^:]+:(.+)$/.exec(body.id)
    assertFlashTestModel(match ? match[1] : undefined)
    return
  }
  // AI SDK Gateway carries the effective model in its header, not JSON.
  const headerModels = ['ai-language-model-id', 'ai-model-id'].map(name => request.headers.get(name)).filter(Boolean)
  for (const model of headerModels) assertFlashTestModel(model)
  if (body.model !== undefined || !headerModels.length) assertFlashTestModel(body.model)
}
