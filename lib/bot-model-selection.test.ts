import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { COORDINATOR_MODEL } from './coordinator/model'
import type { SubscriptionService } from './subscription-service'
import type { BotSubscriptionChoice } from './bot-model-choice'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { ownerId: 'alice', botId: null, workspaceId: id(2) }
const binding = { id: id(3), ownerId: 'alice', consumerId: id(1), workspaceId: id(2), connectionId: id(4), connectionRevision: 7, modelId: 'subscription-model', route: 'claude_cpa' }
let selected: string | undefined
let available: { bindingId: string; provider?: string }[] = []
let savedBinding: Pick<BotSubscriptionChoice, 'bindingId'> & Partial<BotSubscriptionChoice> | undefined
let sharedAvailable: BotSubscriptionChoice[] = []
let sharedSaved: BotSubscriptionChoice | undefined
let settingsError: Error | undefined
let catalogueError: Error | undefined
let catalogueReads = 0
const bindingReads: unknown[][] = []
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
    async chatModels() { catalogueReads++; if (catalogueError) throw catalogueError; return available }
    async pooledBindings() { return sharedAvailable }
    async chatBinding(...args: unknown[]) { bindingReads.push(args); return savedBinding }
    async sharedChatBinding(_scope: unknown, botId: string, bindingId: string) {
      return botId === id(1) && sharedSaved?.bindingId === bindingId ? sharedSaved : undefined
    }
    async bindingForBot(_scope: unknown, _bot: unknown, bindingId: string) { return bindingId }
    async bindingForOthersBot(_scope: unknown, _bot: unknown, _owner: unknown, bindingId: string) { return bindingId }
  },
} })
let keyChoice: { keyId: string; model: string; harness: string } | undefined
let usableKeys: { id: string; provider: string; baseUrl: string | null; protocol: string; models: string[]; mine?: boolean; name?: string | null }[] = []
const chatModels: unknown[] = []
mock.module(new URL('./model-api-keys.ts', import.meta.url).href, { namedExports: {
  botApiKeyChoice: async () => keyChoice,
  usableApiKeys: async () => usableKeys,
  apiKeyAfterQuota: async () => true,
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
  catalogueError = undefined
  catalogueReads = 0
  bindingReads.length = 0
  workspaceCalls = 0
  workspaceBots.length = 0
  hostedCalls.length = 0
  keyChoice = undefined
  usableKeys = []
  chatModels.length = 0
  pointsRefusal = null
  fallback = null
})

test('A bot saved on an API key model freezes that key and resolves through it; an unusable key falls back', async () => {
  const botScope = { ...scope, botId: id(1) }
  keyChoice = { keyId: id(9), model: 'deepseek-chat', harness: 'claude_code' }
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['deepseek-chat'] }]
  const frozen = await freezeBotModel(botScope, noSubscription)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: 'deepseek-chat', modelSelection: { consumerId: id(1), type: 'api_key', keyId: id(9), ownerId: 'alice', workspaceId: id(2), modelId: 'deepseek-chat' } })
  assert.deepEqual(await resolveFrozenHostedModel(botScope, frozen, noSubscription), { modelId: 'api-key-fixture' })
  assert.equal(chatModels.length, 1)
  await assert.rejects(resolveFrozenHostedModel({ ...botScope, ownerId: 'mallory' }, frozen, noSubscription), { code: 'binding_mismatch' })
  await assert.rejects(resolveFrozenHostedModel({ ...botScope, botId: id(5) }, frozen, noSubscription), { code: 'binding_mismatch' })
  // The key was withdrawn: the usual order, here Mikka 默认.
  usableKeys = []
  assert.deepEqual(await freezeBotModel(botScope, noSubscription), { harness: 'ai_sdk', model: COORDINATOR_MODEL })
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['different-model'] }]
  assert.deepEqual(await freezeBotModel(botScope, noSubscription), { harness: 'ai_sdk', model: COORDINATOR_MODEL })
  // An Anthropic-only custom provider cannot serve a bot chat.
  usableKeys = [{ id: id(9), provider: 'custom', baseUrl: 'https://llm.example/anthropic', protocol: 'anthropic', models: ['deepseek-chat'] }]
  assert.deepEqual(await freezeBotModel(botScope, noSubscription), { harness: 'ai_sdk', model: COORDINATOR_MODEL })
})

test('Coordinator without a subscription freezes and resolves the configured hosted default', async () => {
  const frozen = await freezeBotModel({ ...scope, workspaceId: null }, noSubscription)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: COORDINATOR_MODEL })
  assert.equal(workspaceCalls, 1)
  assert.equal(await resolveFrozenHostedModel(scope, frozen, noSubscription), hostedModel)
  assert.deepEqual(hostedCalls, [[scope, COORDINATOR_MODEL]])
})

test('a saved choice whose account is gone, with no subscription bound, replies on Mikka 默认', async () => {
  // The Settings page showed 未连接账号 and these bots refused (binding_required) instead of replying.
  selected = id(9)
  available = []
  for (const botId of [null, id(1)]) {
    const frozen = await freezeBotModel({ ...scope, botId }, noSubscription)
    assert.deepEqual(frozen, { harness: 'ai_sdk', model: COORDINATOR_MODEL })
  }
})

test('Mikka 默认 picked in the composer stays hosted while a subscription is bound', async () => {
  selected = '00000000-0000-0000-0000-000000000000'
  available = [{ bindingId: binding.id, provider: 'claude' }]
  savedBinding = { bindingId: binding.id }
  for (const botId of [null, id(1)]) {
    const frozen = await freezeBotModel({ ...scope, botId }, noSubscription)
    assert.deepEqual(frozen, { harness: 'ai_sdk', model: COORDINATOR_MODEL })
  }
})

test('Bot without a subscription replies on the same hosted default as the Coordinator, in its own workspace', async () => {
  const bot = { ...scope, botId: id(1) }
  const frozen = await freezeBotModel({ ...bot, workspaceId: null }, noSubscription)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: COORDINATOR_MODEL })
  assert.deepEqual(workspaceBots, [bot.botId])
  // Same hosted path as the Coordinator: the hosted model applies admission and billing for this bot's workspace.
  assert.equal(await resolveFrozenHostedModel(bot, frozen, noSubscription), hostedModel)
  assert.deepEqual(hostedCalls, [[bot, COORDINATOR_MODEL]])
})

test('a saved choice whose account is gone switches to a bound subscription, Claude first, not Mikka 默认', async () => {
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
  const frozen = await freezeBotModel(scope, dependencies)
  assert.equal((frozen.modelSelection as { bindingId?: string } | undefined)?.bindingId, binding.id)
  assert.equal(frozen.model, binding.modelId)
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

test('an explicit shared subscription freezes its exact saved model before own or pooled defaults', async () => {
  catalogueError = new Error('unrelated own catalogue unavailable')
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
  const frozen = await freezeBotModel(botScope, dependencies)
  assert.equal(frozen.model, 'gpt-6-luna')
  assert.equal(frozen.modelSelection?.type, 'subscription')
  assert.deepEqual(frozen.modelSelection, { type: 'subscription', bindingId: shared.id,
    ownerId: 'bob', runOwnerId: 'alice', consumerId: botScope.botId, workspaceId: botScope.workspaceId,
    connectionId: shared.connectionId, connectionRevision: 7, modelId: 'gpt-6-luna', route: 'codex_cpa' })
  assert.equal(catalogueReads, 0)
})

test('shared subscription menu exposes both providers without private account or quota details', async () => {
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
  const shared = menu.groups.filter(group => group.kind === 'subscription')
  assert.deepEqual(shared.map(group => [group.provider, group.owner, group.credentialLabel, group.plan]),
    [['claude', 'Public teammate', 'Public teammate', undefined], ['codex', 'Public teammate', 'Public teammate', undefined]])
  assert.deepEqual(shared.flatMap(group => group.options), sharedAvailable.map(row => ({ id: row.bindingId, modelId: row.modelId, provider: row.provider })))
  assert.deepEqual([menu.current.id, menu.current.modelId, menu.current.chosen, menu.current.credentialLabel],
    [id(33), 'gpt-6-luna', true, 'Public teammate'])
  assert.equal(menu.current.quota, undefined)
  assert.ok(!JSON.stringify(menu).includes('PRIVATE-'))
  assert.ok(!JSON.stringify(menu).includes('2099-01-01'))
  assert.equal(ownSubscriptionOption(menu), null)
  sharedAvailable = []
  const withoutCatalogue = await botModelMenu(query, new ExecutionSettings(query), scope, id(1))
  assert.deepEqual([withoutCatalogue.current.modelId, withoutCatalogue.current.chosen, withoutCatalogue.current.credentialLabel],
    ['gpt-6-luna', true, 'Public teammate'])
})

test('an archived bot (its owner left the team) is refused before any model is chosen', async () => {
  botActive = false
  try {
    await assert.rejects(freezeBotModel({ ...scope, botId: id(1) }, noSubscription), { code: 'botNotFound' })
    assert.equal(hostedCalls.length, 0)
  } finally { botActive = true }
})

test('Mikka 默认 with no points here runs on the next allowed model and says so; with none, it stays and is refused', async () => {
  selected = '00000000-0000-0000-0000-000000000000'
  pointsRefusal = 'verification_required'
  // Nothing else can run: Mikka 默认 stays, and its refusal explains (decision 2026-11-02-1450).
  assert.deepEqual(await freezeBotModel(scope, noSubscription), { harness: 'ai_sdk', model: COORDINATOR_MODEL })
  // The person's own key is next in 允许使用的模型: this turn runs on it, marked.
  fallback = { kind: 'api_key', keyId: id(9), model: 'deepseek-chat' }
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['deepseek-chat'] }]
  assert.deepEqual(await freezeBotModel({ ...scope, botId: id(1) }, noSubscription), { harness: 'ai_sdk', model: 'deepseek-chat',
    modelSelection: { consumerId: id(1), type: 'api_key', keyId: id(9), ownerId: 'alice', workspaceId: id(2), modelId: 'deepseek-chat', afterPoints: true } })
  // A subscription is next: frozen as usual, marked.
  fallback = { kind: 'subscription', bindingId: binding.id, model: binding.modelId }
  savedBinding = { bindingId: binding.id }
  const dependencies = {
    service: () => ({ repository: {
      binding: async () => ({ ...binding }),
      connection: async () => ({ ownerId: scope.ownerId, workspaceId: scope.workspaceId, epoch: '7', state: 'connected' }),
    } }) as unknown as SubscriptionService,
    workspace: async () => {},
  }
  const frozen = await freezeBotModel(scope, dependencies)
  assert.equal(frozen.model, binding.modelId)
  assert.deepEqual([(frozen.modelSelection as { bindingId?: string }).bindingId, (frozen.modelSelection as { afterPoints?: true }).afterPoints], [binding.id, true])
  // Points left: Mikka 默认, whatever else could run.
  pointsRefusal = null
  assert.deepEqual(await freezeBotModel(scope, noSubscription), { harness: 'ai_sdk', model: COORDINATOR_MODEL })
})

 test('a disabled hosted source never starts a new hosted turn', async () => {
  hostedEnabled = false
  try {
    await assert.rejects(freezeBotModel(scope, noSubscription), /executionModelUnknown/)
  } finally { hostedEnabled = true }
})

 test('an unavailable saved model follows the preferred source and preserves its old frozen turn', async () => {
  const botScope = { ...scope, botId: id(1) }
  keyChoice = { keyId: id(9), model: 'old-model', harness: 'claude_code' }
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic', models: ['old-model', 'next-model'] }]
  const frozen = await freezeBotModel(botScope, noSubscription)
  usableKeys[0].models = ['next-model']
  fallback = { kind: 'api_key', keyId: id(9), model: 'next-model' }
  const next = await freezeBotModel(botScope, noSubscription)
  assert.equal(next.model, 'next-model')
  assert.equal(frozen.model, 'old-model')
  assert.deepEqual(await resolveFrozenHostedModel(botScope, frozen, noSubscription), { modelId: 'api-key-fixture' })
})

test('a saved subscription freezes its exact model without unrelated catalogue work and still checks current authority', async () => {
  catalogueError = new Error('unrelated catalogue unavailable')
  let connectionState = 'connected'
  let authorityReads = 0
  for (const [modelId, route] of [['claude-haiku-5-5', 'claude_cpa'], ['gpt-6-luna', 'codex_cpa']]) {
    const current = { ...binding, modelId, route }
    selected = current.id
    savedBinding = { bindingId: current.id }
    const dependencies = {
      service: () => ({ repository: {
        binding: async (ownerId: string, bindingId: string) => {
          assert.equal(ownerId, scope.ownerId)
          assert.equal(bindingId, current.id)
          return current
        },
        connection: async (ownerId: string, connectionId: string) => {
          assert.equal(ownerId, scope.ownerId)
          assert.equal(connectionId, current.connectionId)
          return { ownerId, epoch: '7', state: connectionState }
        },
      } }) as unknown as SubscriptionService,
      workspace: async (ownerId: string, workspaceId: string) => {
        assert.equal(ownerId, scope.ownerId)
        assert.equal(workspaceId, scope.workspaceId)
        authorityReads++
      },
    }
    connectionState = 'connected'
    const frozen = await freezeBotModel(scope, dependencies)
    assert.deepEqual(frozen, { harness: 'ai_sdk', model: modelId, modelSelection: {
      coordinator: true, type: 'subscription', bindingId: current.id, ownerId: scope.ownerId,
      consumerId: current.consumerId, workspaceId: scope.workspaceId, connectionId: current.connectionId,
      connectionRevision: 7, modelId, route,
    } })
    connectionState = 'disconnected'
    await assert.rejects(freezeBotModel(scope, dependencies), { code: 'binding_mismatch' })
  }
  assert.equal(authorityReads, 4)
  assert.equal(catalogueReads, 0)
  assert.deepEqual(bindingReads, Array.from({ length: 4 }, () => [{ ownerId: scope.ownerId, workspaceId: scope.workspaceId }, binding.id]))
})

test('an unavailable saved subscription still reads the fallback catalogue and propagates its failure', async () => {
  selected = binding.id
  const unavailable = new Error('fallback catalogue unavailable')
  catalogueError = unavailable
  await assert.rejects(freezeBotModel(scope, noSubscription), error => error === unavailable)
  assert.equal(catalogueReads, 1)
  assert.deepEqual(bindingReads, [[{ ownerId: scope.ownerId, workspaceId: scope.workspaceId }, binding.id]])
})

test('a saved exhausted subscription retains its same-model quota fallback without reading the catalogue', async () => {
  selected = binding.id
  catalogueError = new Error('unrelated catalogue unavailable')
  savedBinding = {
    ...binding, bindingId: binding.id, provider: 'claude', plan: 'Max',
    quota: { vendor: 'claude_code', source: 'official', status: 'ok', plan: 'Max',
      windows: [{ kind: 'five_hour', used: 1, resetsAt: '2099-01-01T00:00:00.000Z' }],
      observedAt: new Date().toISOString() },
  }
  usableKeys = [{ id: id(9), provider: 'deepseek', baseUrl: null, protocol: 'anthropic',
    models: [binding.modelId], mine: true, name: 'Own fallback key' }]
  const frozen = await freezeBotModel(scope, noSubscription)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: binding.modelId, modelSelection: {
    coordinator: true, type: 'api_key', keyId: id(9), ownerId: scope.ownerId,
    workspaceId: scope.workspaceId, modelId: binding.modelId,
    afterQuota: { subscription: 'claude', plan: 'Max', keyProvider: 'deepseek', keyName: 'Own fallback key' },
  } })
  assert.equal(catalogueReads, 0)
})
