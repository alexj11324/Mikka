import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { COORDINATOR_MODEL } from './coordinator/model'
import type { SubscriptionService } from './subscription-service'
import type { BotSubscriptionChoice } from './bot-model-choice'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { ownerId: 'alice', actorId: 'alice', botId: null, workspaceId: id(2) }
const binding = { id: id(3), ownerId: 'alice', consumerId: id(1), workspaceId: id(2), connectionId: id(4), connectionRevision: 7, modelId: 'subscription-model', route: 'claude_cpa' }
let selected: string | undefined
let available: { bindingId: string; provider?: string }[] = []
let savedBinding: { bindingId: string } | undefined
let sharedAvailable: BotSubscriptionChoice[] = []
let sharedSaved: BotSubscriptionChoice | undefined
let settingsError: Error | undefined
let workspaceCalls = 0
let botActive = true
const workspaceBots: (string | null)[] = []
let hostedEnabled = true
mock.module('./enabled-models', { namedExports: { hostedModelEnabled: async () => hostedEnabled } })
const hostedCalls: unknown[][] = []
const hostedModel = { modelId: 'hosted-fixture' }
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { pool: null } })
mock.module(new URL('./workspace-db.ts', import.meta.url).href, { namedExports: {
  workspaceDb: { select: () => ({ from: () => ({ where: async () => [{ userId: 'bob', name: 'Public teammate' }] }) }) },
} })
mock.module(new URL('./execution-settings.ts', import.meta.url).href, { namedExports: {
  executionWorkspace: async (owner: string, bot: string | null) => {
    assert.equal(owner, scope.ownerId)
    workspaceBots.push(bot)
    workspaceCalls++
    return scope.workspaceId
  },
  ExecutionSettings: class {
    async botActive() { return botActive }
    async botModel() { if (settingsError) throw settingsError; return selected }
    async chatModels() { return available }
    async pooledBindings() { return sharedAvailable }
    async chatBinding() { return savedBinding }
    async sharedChatBinding(_scope: unknown, botId: string, bindingId: string) {
      return botId === id(1) && sharedSaved?.bindingId === bindingId ? sharedSaved : undefined
    }
    async bindingForBot(_scope: unknown, _bot: unknown, bindingId: string) { return bindingId }
    async bindingForOthersBot(_scope: unknown, _bot: unknown, _owner: unknown, bindingId: string) { return bindingId }
  },
} })
let keyChoice: { keyId: string; model: string; harness: string } | undefined
let usableKeys: { id: string; provider: string; baseUrl: string | null; protocol: string; models: string[]; ownerId?: string; mine?: boolean; ownership?: 'organization'; organizationId?: string; organizationName?: string; revision?: number; name?: string; last4?: string }[] = []
const chatModels: unknown[] = []
mock.module(new URL('./model-api-keys.ts', import.meta.url).href, { namedExports: {
  assertHostedApiKeyAuthority: async (_query: unknown, actual: {ownerId:string;actorId:string}) => { assert.equal(actual.actorId, actual.ownerId) },
  botApiKeyChoice: async () => keyChoice,
  usableApiKeys: async () => usableKeys,
} })
mock.module(new URL('./model-api-key-chat.ts', import.meta.url).href, { namedExports: {
  resolveApiKeyChatModel: async (frozen: unknown) => { chatModels.push(frozen); return { modelId: 'api-key-fixture' } },
} })
let pointsRefusal: string | null = null
let fallback: { kind: 'api_key'; keyId: string; model: string } | { kind: 'subscription'; bindingId: string; model: string } | null = null
mock.module(new URL('./points-fallback.ts', import.meta.url).href, { namedExports: {
  hostedPointsRefusal: async (workspaceId: string) => { assert.equal(workspaceId, scope.workspaceId); return pointsRefusal },
  pointsFallback: async () => fallback,
  hostedPointsHere: async () => ({ points: 1, trialLeft: 0 }),
} })
mock.module(new URL('./abuse/resolve.ts', import.meta.url).href, { namedExports: {
  resolveDefaultHostedModel: async (...args: unknown[]) => { hostedCalls.push(args); return hostedModel },
} })
let freezeBotModel: typeof import('./bot-model-selection')['freezeBotModel']
let resolveFrozenHostedModel: typeof import('./subscription-model-snapshot')['resolveFrozenHostedModel']
const savedEdition = process.env.MIKKA_EDITION
before(async () => {
  // This fixture exercises the official hosted-points fallback; community
  // defaults and cloud bindings have separate model/readiness coverage.
  process.env.MIKKA_EDITION = 'cloud'
  ;({ freezeBotModel } = await import('./bot-model-selection'))
  ;({ resolveFrozenHostedModel } = await import('./subscription-model-snapshot'))
})
after(() => {
  if (savedEdition === undefined) delete process.env.MIKKA_EDITION
  else process.env.MIKKA_EDITION = savedEdition
})
const noSubscription = {
  service: () => { throw new Error('subscription backend must not be constructed') },
  workspace: async () => { throw new Error('subscription authority must not be requested') },
}
beforeEach(() => {
  selected = undefined
  available = []
  savedBinding = undefined
  sharedAvailable = []
  sharedSaved = undefined
  settingsError = undefined
  workspaceCalls = 0
  workspaceBots.length = 0
  hostedCalls.length = 0
  keyChoice = undefined
  usableKeys = []
  chatModels.length = 0
  pointsRefusal = null
  fallback = null
})

test('A bot freezes its chosen API key; a revoked or unavailable explicit choice requires a new choice', async () => {
  const botScope = { ...scope, botId: id(1) }
  keyChoice = { keyId: id(9), model: 'deepseek-chat', harness: 'claude_code' }
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['deepseek-chat'] }]
  const frozen = await freezeBotModel(botScope, noSubscription)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: 'deepseek-chat', actorId: 'alice', modelSelection: { consumerId: id(1), type: 'api_key', keyId: id(9), ownerId: 'alice', actorId: 'alice', workspaceId: id(2), modelId: 'deepseek-chat' } })
  assert.deepEqual(await resolveFrozenHostedModel(botScope, frozen, noSubscription), { modelId: 'api-key-fixture' })
  assert.equal(chatModels.length, 1)
  await assert.rejects(resolveFrozenHostedModel({ ...botScope, ownerId: 'mallory' }, frozen, noSubscription), { code: 'binding_mismatch' })
  await assert.rejects(resolveFrozenHostedModel({ ...botScope, botId: id(5) }, frozen, noSubscription), { code: 'binding_mismatch' })
  // A withdrawn key cannot silently select a different payer or model.
  usableKeys = []
  await assert.rejects(freezeBotModel(botScope, noSubscription), { code: 'executionModelUnknown' })
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['different-model'] }]
  await assert.rejects(freezeBotModel(botScope, noSubscription), { code: 'executionModelUnknown' })
  // An Anthropic-only custom provider cannot serve a bot chat.
  usableKeys = [{ id: id(9), provider: 'custom', baseUrl: 'https://llm.example/anthropic', protocol: 'anthropic', models: ['deepseek-chat'] }]
  await assert.rejects(freezeBotModel(botScope, noSubscription), { code: 'executionModelUnknown' })
})

test('Coordinator without a subscription freezes and resolves the configured hosted default', async () => {
  const frozen = await freezeBotModel({ ...scope, workspaceId: null }, noSubscription)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: COORDINATOR_MODEL, actorId: 'alice' })
  assert.equal(workspaceCalls, 1)
  assert.equal(await resolveFrozenHostedModel(scope, frozen, noSubscription), hostedModel)
  assert.deepEqual(hostedCalls, [[scope, COORDINATOR_MODEL]])
})
test('a caller without an actual actor cannot select a model, and another actor cannot use a personal choice', async () => {
  await assert.rejects(freezeBotModel({ ...scope, actorId: undefined } as unknown as typeof scope, noSubscription), { code: 'binding_mismatch' })
  const peer = { ...scope, actorId: 'bob' }
  await assert.rejects(freezeBotModel(peer, noSubscription), { code: 'executionModelUnknown' })
  keyChoice = { keyId: id(9), model: 'deepseek-chat', harness: 'claude_code' }
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['deepseek-chat'], ownerId: 'alice' }]
  await assert.rejects(freezeBotModel(peer, noSubscription), { code: 'executionModelUnknown' })
  assert.deepEqual(chatModels, [])
})

test('a saved choice whose account is gone requires a new explicit choice', async () => {
  // No subscription fallback may charge another source merely because an account disappeared.
  selected = id(9)
  available = []
  for (const botId of [null, id(1)]) {
    await assert.rejects(freezeBotModel({ ...scope, botId }, noSubscription), { code: 'executionModelUnknown' })
  }
})

test('Mikka 默认 picked in the composer stays hosted while a subscription is bound', async () => {
  selected = '00000000-0000-0000-0000-000000000000'
  available = [{ bindingId: binding.id, provider: 'claude' }]
  savedBinding = { bindingId: binding.id }
  for (const botId of [null, id(1)]) {
    const frozen = await freezeBotModel({ ...scope, botId }, noSubscription)
    assert.deepEqual(frozen, { harness: 'ai_sdk', model: COORDINATOR_MODEL, actorId: 'alice' })
  }
})

test('Bot without a subscription replies on the same hosted default as the Coordinator, in its own workspace', async () => {
  const bot = { ...scope, botId: id(1) }
  const frozen = await freezeBotModel({ ...bot, workspaceId: null }, noSubscription)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: COORDINATOR_MODEL, actorId: 'alice' })
  assert.deepEqual(workspaceBots, [bot.botId])
  // Same hosted path as the Coordinator: the hosted model applies admission and billing for this bot's workspace.
  assert.equal(await resolveFrozenHostedModel(bot, frozen, noSubscription), hostedModel)
  assert.deepEqual(hostedCalls, [[bot, COORDINATOR_MODEL]])
})

test('a lost saved choice cannot silently switch to another bound subscription', async () => {
  const dependencies = {
    service: () => ({ repository: {
      binding: async () => ({ ...binding }),
      connection: async () => ({ ownerId: scope.ownerId, workspaceId: scope.workspaceId, epoch: '7', state: 'connected' }),
    } }) as unknown as SubscriptionService,
    workspace: async () => {},
  }
  selected = id(9)
  savedBinding = undefined
  available = [{ bindingId: id(8), provider: 'codex' }, { bindingId: binding.id, provider: 'claude' }]
  await assert.rejects(freezeBotModel(scope, dependencies), { code: 'executionModelUnknown' })
  assert.equal(hostedCalls.length, 0)
})

test('Coordinator still freezes an available or selected subscription with ownership validation', async () => {
  const dependencies = {
    service: () => ({ repository: {
      binding: async () => ({ ...binding }),
      connection: async () => ({ ownerId: scope.ownerId, workspaceId: scope.workspaceId, epoch: '7', state: 'connected' }),
    } }) as unknown as SubscriptionService,
    workspace: async (owner: string, workspace: string) => {
      assert.equal(owner, scope.ownerId)
      assert.equal(workspace, scope.workspaceId)
    },
  }
  for (const explicit of [false, true]) {
    available = [{ bindingId: binding.id }]
    selected = explicit ? binding.id : undefined
    savedBinding = available[0]
    const frozen = await freezeBotModel(scope, dependencies)
    assert.equal(frozen.model, binding.modelId)
    assert.equal((frozen.modelSelection as { bindingId?: string } | undefined)?.bindingId, binding.id)
    assert.equal(frozen.modelSelection?.coordinator, true)
    const foreign = { ...dependencies, service: () => ({ repository: {
      binding: async () => ({ ...binding, ownerId: 'other' }),
    } }) as unknown as SubscriptionService }
    await assert.rejects(freezeBotModel(scope, foreign), { code: 'binding_mismatch' })
  }
  assert.equal(hostedCalls.length, 0)
})

test('settings errors propagate instead of selecting the hosted fallback', async () => {
  settingsError = new Error('database unavailable')
  await assert.rejects(freezeBotModel(scope, noSubscription), settingsError)
  assert.equal(hostedCalls.length, 0)
})

test('an explicit legacy shared subscription is refused before any credential is frozen', async () => {
  const botScope = { ...scope, botId: id(1) }
  available = [{ bindingId: binding.id, provider: 'claude' }]
  const shared = { ...binding, id: id(21), ownerId: 'bob', connectionId: id(22),
    modelId: 'gpt-6-luna', route: 'codex_cpa' }
  selected = shared.id
  sharedSaved = { ...shared, bindingId: shared.id, provider: 'codex' }
  // Catalogue deduplication need not expose the saved per-bot binding id.
  sharedAvailable = [
    { ...sharedSaved, bindingId: id(24), modelId: 'claude-haiku-5-5', provider: 'claude' },
    { ...sharedSaved, bindingId: id(25) },
  ]
  const dependencies = {
    service: () => ({ repository: {
      binding: async (ownerId: string, bindingId: string) => {
        if (ownerId === 'bob' && bindingId === shared.id) return shared
        assert.equal(ownerId, scope.ownerId)
        assert.equal(bindingId, binding.id)
        return binding
      },
      connection: async (ownerId: string) => ({ ownerId, epoch: '7', state: 'connected' }),
    } }) as unknown as SubscriptionService,
    workspace: async (ownerId: string, workspaceId: string) => {
      assert.equal(ownerId, botScope.ownerId)
      assert.equal(workspaceId, botScope.workspaceId)
    },
  }
  await assert.rejects(freezeBotModel(botScope, dependencies), { code: 'executionModelUnknown' })
  assert.equal(hostedCalls.length, 0)
})

test('legacy shared subscription preferences and catalogues expose no teammate connection', async () => {
  const { botModelMenu } = await import('./bot-model-menu')
  const { ExecutionSettings } = await import('./execution-settings')
  const { ownSubscriptionOption } = await import('./bot-model-menu-view')
  const quota = { vendor: 'claude_code', source: 'official', status: 'ok', plan: 'PRIVATE-PLAN',
    windows: [{ kind: 'five_hour', used: 0.2, resetsAt: '2099-01-01T00:00:00.000Z' }], observedAt: new Date().toISOString() }
  sharedAvailable = [
    { bindingId: id(31), connectionId: id(32), ownerId: 'bob', provider: 'claude', modelId: 'claude-haiku-5-5',
      accountLabel: 'PRIVATE-LOGIN', plan: 'PRIVATE-PLAN', quota },
    { bindingId: id(33), connectionId: id(34), ownerId: 'bob', provider: 'codex', modelId: 'gpt-6-luna',
      accountLabel: 'PRIVATE-CODEX-LOGIN', plan: 'PRIVATE-PLAN', quota: { ...quota, vendor: 'codex' } },
  ]
  sharedSaved = { ...sharedAvailable[1], bindingId: id(35) }
  selected = sharedSaved.bindingId
  const query = { query: async () => ({ rows: [{ bindingId: selected }] }) } as never
  const menu = await botModelMenu(query, new ExecutionSettings(query), scope, id(1))
  assert.deepEqual(menu.groups.filter(group => group.kind === 'subscription'), [])
  assert.equal(menu.current.kind, 'hosted')
  assert.equal(menu.current.chosen, false)
  assert.equal(menu.current.fallback, 'preference')
  assert.equal(menu.current.quota, undefined)
  assert.ok(!JSON.stringify(menu).includes('PRIVATE-'))
  assert.ok(!JSON.stringify(menu).includes('2099-01-01'))
  assert.ok(!JSON.stringify(menu).includes('Public teammate'))
  assert.equal(ownSubscriptionOption(menu), null)
  sharedAvailable = []
  assert.deepEqual(await botModelMenu(query, new ExecutionSettings(query), scope, id(1)), menu)
})

test('an archived bot (its owner left the team) is refused before any model is chosen', async () => {
  botActive = false
  try {
    await assert.rejects(freezeBotModel({ ...scope, botId: id(1) }, noSubscription), { code: 'botNotFound' })
    assert.equal(hostedCalls.length, 0)
  } finally { botActive = true }
})

test('exhausted platform points never silently switch a hosted choice to BYO billing or another model', async () => {
  selected = '00000000-0000-0000-0000-000000000000'
  pointsRefusal = 'verification_required'
  for (const alternative of [null, { kind: 'api_key' as const, keyId: id(9), model: 'deepseek-chat' },
    { kind: 'subscription' as const, bindingId: binding.id, model: binding.modelId }]) {
    fallback = alternative
    usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['deepseek-chat'] }]
    savedBinding = { bindingId: binding.id }
    assert.deepEqual(await freezeBotModel(scope, noSubscription), { harness: 'ai_sdk', model: COORDINATOR_MODEL, actorId: 'alice' })
  }
})

 test('a disabled hosted source never starts a new hosted turn', async () => {
  hostedEnabled = false
  try {
    await assert.rejects(freezeBotModel(scope, noSubscription), /executionModelUnknown/)
  } finally { hostedEnabled = true }
})

 test('an unavailable saved model requires a new choice and preserves the historical frozen turn', async () => {
  const botScope = { ...scope, botId: id(1) }
  keyChoice = { keyId: id(9), model: 'old-model', harness: 'claude_code' }
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['old-model', 'next-model'] }]
  const frozen = await freezeBotModel(botScope, noSubscription)
  usableKeys[0].models = ['next-model']
  fallback = { kind: 'api_key', keyId: id(9), model: 'next-model' }
  await assert.rejects(freezeBotModel(botScope, noSubscription), { code: 'executionModelUnknown' })
  assert.equal(frozen.model, 'old-model')
  assert.deepEqual(await resolveFrozenHostedModel(botScope, frozen, noSubscription), { modelId: 'api-key-fixture' })
})


test('Organization connections appear with their billing owner and freeze the exact credential revision', async () => {
  const { botModelMenu } = await import('./bot-model-menu')
  const { ExecutionSettings } = await import('./execution-settings')
  const organizationId = id(50)
  usableKeys = [{ id: id(51), ownerId: `organization:${organizationId}`, ownership: 'organization',
    organizationId, organizationName: 'Fixture organization', mine: false, revision: 3,
    provider: 'deepseek', name: 'Shared gateway', last4: 'test', baseUrl: null, protocol: 'anthropic', models: ['deepseek-chat'] }]
  keyChoice = { keyId: id(51), model: 'deepseek-chat', harness: 'claude_code' }
  const query = { query: async () => ({ rows: [] }) } as never
  const menu = await botModelMenu(query, new ExecutionSettings(query), scope, id(1))
  const connection = menu.groups.find(group => group.kind === 'shared')
  assert.equal(connection?.owner, 'Fixture organization')
  assert.equal(connection?.credentialLabel, 'Shared gateway ····test')
  assert.equal(connection?.options[0].modelId, 'deepseek-chat')
  assert.equal(menu.current.credentialLabel, 'Fixture organization · Shared gateway ····test')
  const frozen = await freezeBotModel({ ...scope, botId: id(1) }, noSubscription)
  assert.deepEqual(frozen.modelSelection, { type: 'api_key', consumerId: id(1), keyId: id(51), ownerId: 'alice', actorId: 'alice',
    workspaceId: scope.workspaceId, modelId: 'deepseek-chat', credentialOwnerId: `organization:${organizationId}`,
    credentialRevision: 3, organizationId })
})
