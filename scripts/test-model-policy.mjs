// Live acceptance/evaluation policy, not a restriction on users' model choices.
// deepseek-flash is the provider's listed Flash alias; this does not assert a
// particular version behind that alias. Never substitute Pro or another model.
const flashModels = new Set(['deepseek-v4.1-flash', 'deepseek-flash', 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-flash'])

export function assertFlashTestModel(model) {
  if (!flashModels.has(model)) throw new Error('Flash-only test policy: model is not an allowed DeepSeek Flash model; request blocked')
}

/** Check the actual outgoing selection/model, before upstream fetch is called. */
export async function assertTestModelRequest(request) {
  const url = new URL(request.url)
  const selection = request.method === 'PUT' && url.pathname.endsWith('/api/mobile/model')
  const generation = request.method === 'POST' && /\/(?:chat\/completions|responses|messages|language-model)$/.test(url.pathname)
  if (!selection && !generation) return
  const body = await request.clone().json()
  if (selection) {
    const match = typeof body.id === 'string' && /^apikey:[^:]+:(.+)$/.exec(body.id)
    assertFlashTestModel(match ? match[1] : undefined)
    return
  }
  // AI SDK Gateway carries the effective model in its header, not JSON.
  const headerModel = request.headers.get('ai-language-model-id') ?? request.headers.get('ai-model-id')
  if (headerModel) assertFlashTestModel(headerModel)
  if (body.model !== undefined || !headerModel) assertFlashTestModel(body.model)
}
