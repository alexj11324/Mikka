import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
import { COORDINATOR_MODEL } from './coordinator/model'
let kind = 'self-hosted', targetReads = 0
mock.module(new URL('./default-model.ts', import.meta.url).href, { namedExports: {
  defaultModelTarget: async () => { targetReads++; return { kind, serviceUrl: 'https://cloud.example.invalid' } },
} })

import type { BotSubscriptionChoice } from './bot-model-choice'
import type { UsableApiKey } from './model-api-keys'
import { HOSTED_CHOICE } from './bot-model-menu-view'

type Fallback = { kind: 'api_key'; keyId: string; model: string } | { kind: 'subscription'; bindingId: string; model: string } | null
let fallback: Fallback = null
let fallbackReads = 0
mock.module(new URL('./model-api-keys.ts', import.meta.url).href, { namedExports: {
  botApiKeyChoice: async () => assert.fail('these choices already carry the saved preference'),
  usableApiKeys: async () => assert.fail('these choices already carry the authorized key list'),
} })
mock.module(new URL('./points-fallback.ts', import.meta.url).href, { namedExports: {
  hostedPointsRefusal: async () => null,
  pointsFallback: async () => { fallbackReads++; return fallback },
} })
let resolveBotModelChoice: typeof import('./bot-model-choice')['resolveBotModelChoice']
const previousEdition = process.env.MIKKA_EDITION
before(async () => {
  process.env.MIKKA_EDITION = 'cloud'
  ;({ resolveBotModelChoice } = await import('./bot-model-choice'))
})
after(() => {
  if (previousEdition === undefined) delete process.env.MIKKA_EDITION
  else process.env.MIKKA_EDITION = previousEdition
})
beforeEach(() => { fallback = null; fallbackReads = 0 })

const binding: BotSubscriptionChoice = {
  bindingId: '10000000-0000-4000-8000-000000000001',
  connectionId: '10000000-0000-4000-8000-000000000002',
  ownerId: 'alice', modelId: 'claude-haiku-5-5', provider: 'claude',
}
const key: UsableApiKey = {
  id: '10000000-0000-4000-8000-000000000003', ownerId: 'alice', mine: true,
  provider: 'openai', name: null, baseUrl: null, protocol: 'openai',
  last4: 'test', models: ['gpt-6-luna'], modelsError: null, responsesApi: true,
}

function fixture(ownerId = 'alice', flags: (boolean | Error)[] = [true]) {
  const scope = { ownerId, workspaceId: '10000000-0000-4000-8000-000000000004' }
  const calls: string[] = []
  const state = { own: [] as BotSubscriptionChoice[], selected: undefined as BotSubscriptionChoice | undefined,
    shared: undefined as BotSubscriptionChoice | undefined, pooled: [] as BotSubscriptionChoice[] }
  const query = { query: async (sql: string, values: unknown[]) => {
    // Exercise the real hostedModelEnabled SQL, not a mocked policy result.
    assert.match(sql, /SELECT COALESCE.*hostedModelEnabled.*FROM "user" u WHERE id=\$1/)
    assert.deepEqual(values, [ownerId])
    calls.push('hosted')
    const flag = flags.length > 1 ? flags.shift()! : flags[0]!
    if (flag instanceof Error) throw flag
    return { rows: [{ enabled: flag }] }
  } }
  const settings = {
    chatModels: async () => { calls.push('models'); return state.own },
    chatBinding: async (actual: typeof scope, id: string) => {
      assert.deepEqual(actual, scope); calls.push('binding')
      return state.selected?.bindingId === id ? state.selected : undefined
    },
    sharedChatBinding: async (actual: typeof scope, _botId: string, id: string) => {
      assert.deepEqual(actual, scope); calls.push('shared')
      return state.shared?.bindingId === id ? state.shared : undefined
    },
    pooledBindings: async () => { calls.push('pooled'); return state.pooled },
  }
  return { scope, query, settings, calls, state }
}
const choose = (f: ReturnType<typeof fixture>, preference: Parameters<typeof resolveBotModelChoice>[4] = {}, keys: UsableApiKey[] = []) =>
  resolveBotModelChoice(f.query as never, f.settings, f.scope, '10000000-0000-4000-8000-000000000005', preference, { keys })

test('hosted settings expose the actual default target when cloud supersedes a configured local provider', async () => {
  const names = ['MIKKA_EDITION', 'MIKKA_DEFAULT_MODEL_BASE_URL', 'MIKKA_DEFAULT_MODEL_API_KEY', 'MIKKA_DEFAULT_MODEL_ID']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  try {
    Object.assign(process.env, { MIKKA_EDITION: 'community', MIKKA_DEFAULT_MODEL_BASE_URL: 'https://provider.example.invalid/v1',
      MIKKA_DEFAULT_MODEL_API_KEY: 'synthetic-fixture-only', MIKKA_DEFAULT_MODEL_ID: 'local-configured-model' })
    const { readEnabledModels } = await import('./enabled-models')
    const query = { query: async (sql: string) => ({ rows: sql.includes('FROM "user"') ? [{ enabled: true }] : [] }) } as unknown as Pool
    const scope = { ownerId: 'fixture-owner', workspaceId: '10000000-0000-4000-8000-000000000001' }
    const model = async () => (await readEnabledModels(query, scope)).sources.find(source => source.id === 'hosted')!.models[0].id
    assert.equal(await model(), 'local-configured-model')
    kind = 'cloud'
    assert.equal(await model(), COORDINATOR_MODEL, 'the inactive local provider must not be shown as the cloud model')
    assert.equal(targetReads, 2)
    process.env.MIKKA_EDITION = 'cloud'
    assert.equal(await model(), COORDINATOR_MODEL)
    assert.equal(targetReads, 2, 'cloud edition does not read a self-hosted binding')
  } finally {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]
  }
})

for (const source of ['selected', 'default'] as const) test(`a valid ${source} subscription does not query unrelated hosted policy`, async () => {
  const f = fixture('alice', [new Error('the unrelated hosted read must not run')])
  const selected = binding
  if (source === 'selected') f.state.selected = selected
  else if (source === 'default') f.state.own = [selected]
  const explicit = source === 'selected'
  const result = await choose(f, explicit ? { selected: binding.bindingId } : {})
  assert.deepEqual(result, { kind: 'subscription', binding: selected, chosen: explicit })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 0)
})

for (const source of ['shared', 'pooled'] as const) test(`a legacy ${source} subscription is never selected or queried`, async () => {
  const f = fixture('alice', [true])
  if (source === 'shared') f.state.shared = { ...binding, ownerId: 'bob' }
  else f.state.pooled = [{ ...binding, ownerId: 'bob' }]
  const choice = await choose(f, source === 'shared' ? { selected: binding.bindingId } : {})
  assert.equal(choice.kind, 'hosted')
  assert.equal(choice.chosen, false)
  assert.ok(!f.calls.includes('shared') && !f.calls.includes('pooled'))
})

test('a valid explicit API key does not query hosted policy', async () => {
  const f = fixture('alice', [new Error('the unrelated hosted read must not run')])
  assert.deepEqual(await choose(f, { key: { keyId: key.id, model: 'gpt-6-luna' } }, [key]),
    { kind: 'apiKey', key, model: 'gpt-6-luna', chosen: true })
  assert.deepEqual(f.calls, [])
})

test('explicit hosted choice reads once before subscriptions and each new choice reads fresh policy', async () => {
  const f = fixture('alice', [true, false])
  f.state.own = [binding]
  assert.deepEqual(await choose(f, { selected: HOSTED_CHOICE }), { kind: 'hosted', chosen: true })
  assert.deepEqual(f.calls, ['hosted'])
  f.state.own = []
  await assert.rejects(choose(f, { selected: HOSTED_CHOICE }), { code: 'executionModelUnknown' })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 2, 'false is reused by both consumers; no cross-call cache')
  assert.equal(f.calls[1], 'hosted', 'the explicit choice still checks policy before reading subscriptions')
})

test('disabled explicit hosted choice keeps an available subscription fallback', async () => {
  const f = fixture('alice', [false])
  f.state.own = [binding]
  assert.deepEqual(await choose(f, { selected: HOSTED_CHOICE }), {
    kind: 'subscription', binding, chosen: false, fallback: 'preference',
  })
  assert.equal(f.calls[0], 'hosted')
  assert.equal(f.calls.filter(call => call === 'hosted').length, 1)
})

for (const kind of ['subscription', 'api_key'] as const) test(`disabled implicit hosted choice keeps the configured ${kind} fallback`, async () => {
  const f = fixture('alice', [false])
  if (kind === 'subscription') {
    fallback = { kind, bindingId: binding.bindingId, model: binding.modelId }
    f.state.selected = binding
  } else fallback = { kind, keyId: key.id, model: 'gpt-6-luna' }
  assert.deepEqual(await choose(f, {}, [key]), kind === 'subscription'
    ? { kind: 'subscription', binding, chosen: false, fallback: 'preference' }
    : { kind: 'apiKey', key, model: 'gpt-6-luna', chosen: false, fallback: 'preference' })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 1)
  assert.equal(fallbackReads, 1)
})

test('actual hosted policy failure propagates without fallback and the next invocation can recover', async () => {
  const failure = new Error('synthetic hosted policy read failure')
  const f = fixture('alice', [failure, true])
  await assert.rejects(choose(f), error => error === failure)
  assert.equal(fallbackReads, 0)
  assert.deepEqual(await choose(f), { kind: 'hosted', chosen: false })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 2)
})

test('concurrent owners do not share hosted policy and community defaults still respect disabled hosted', async () => {
  const alice = fixture('alice', [true]), bob = fixture('bob', [false])
  const results = await Promise.allSettled([choose(alice), choose(bob)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(alice.calls.filter(call => call === 'hosted').length, 1)
  assert.equal(bob.calls.filter(call => call === 'hosted').length, 1)
  process.env.MIKKA_EDITION = 'community'
  try { await assert.rejects(choose(fixture('alice', [false])), { code: 'executionModelUnknown' }) }
  finally { process.env.MIKKA_EDITION = 'cloud' }
})
