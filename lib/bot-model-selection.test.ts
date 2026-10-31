import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { COORDINATOR_MODEL } from './coordinator/model'
import type { SubscriptionService } from './subscription-service'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { ownerId: 'alice', botId: null, workspaceId: id(2) }
const binding = { id: id(3), ownerId: 'alice', consumerId: id(1), workspaceId: id(2), connectionId: id(4), connectionRevision: 7, modelId: 'subscription-model', route: 'claude_cpa' }
let selected: string | undefined
let available: { bindingId: string }[] = []
let savedBinding: { bindingId: string } | undefined
let settingsError: Error | undefined
let workspaceCalls = 0
const workspaceBots: (string | null)[] = []
const hostedCalls: unknown[][] = []
const hostedModel = { modelId: 'hosted-fixture' }
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { pool: null } })
mock.module(new URL('./execution-settings.ts', import.meta.url).href, { namedExports: {
  executionWorkspace: async (owner: string, bot: string | null) => {
    assert.equal(owner, scope.ownerId)
    workspaceBots.push(bot)
    workspaceCalls++
    return scope.workspaceId
  },
  ExecutionSettings: class {
    async botModel() { if (settingsError) throw settingsError; return selected }
    async botModels() { return available }
    async botBinding() { return savedBinding }
    async bindingForBot(_scope: unknown, _bot: unknown, bindingId: string) { return bindingId }
  },
} })
mock.module(new URL('./abuse/resolve.ts', import.meta.url).href, { namedExports: {
  resolveDefaultHostedModel: async (...args: unknown[]) => { hostedCalls.push(args); return hostedModel },
} })
let freezeBotModel: typeof import('./bot-model-selection')['freezeBotModel']
let resolveFrozenHostedModel: typeof import('./subscription-model-snapshot')['resolveFrozenHostedModel']
before(async () => {
  ;({ freezeBotModel } = await import('./bot-model-selection'))
  ;({ resolveFrozenHostedModel } = await import('./subscription-model-snapshot'))
})
const noSubscription = {
  service: () => { throw new Error('subscription backend must not be constructed') },
  workspace: async () => { throw new Error('subscription authority must not be requested') },
}
beforeEach(() => {
  selected = undefined
  available = []
  savedBinding = undefined
  settingsError = undefined
  workspaceCalls = 0
  workspaceBots.length = 0
  hostedCalls.length = 0
})

test('Coordinator without a subscription freezes and resolves the configured hosted default', async () => {
  const frozen = await freezeBotModel({ ...scope, workspaceId: null }, noSubscription)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: COORDINATOR_MODEL })
  assert.equal(workspaceCalls, 1)
  assert.equal(await resolveFrozenHostedModel(scope, frozen, noSubscription), hostedModel)
  assert.deepEqual(hostedCalls, [[scope, COORDINATOR_MODEL]])
})

test('unavailable explicit Coordinator subscription never falls back even with another available binding', async () => {
  selected = id(9)
  for (const options of [[], [{ bindingId: id(3) }]]) {
    available = options
    await assert.rejects(freezeBotModel(scope, noSubscription), { code: 'binding_required' })
  }
  assert.equal(hostedCalls.length, 0)
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

test('Bot with a chosen but missing or revoked binding refuses and never takes the hosted default', async () => {
  selected = id(9)
  for (const options of [[], [{ bindingId: id(3) }]]) {
    available = options
    await assert.rejects(freezeBotModel({ ...scope, botId: id(1) }, noSubscription), { code: 'binding_required' })
  }
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
    assert.equal(frozen.modelSelection?.bindingId, binding.id)
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
