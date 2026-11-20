import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
let kind = 'hosted'
mock.module(new URL('./default-model.ts', import.meta.url).href, { namedExports: {
  defaultModelTarget: async () => kind === 'none' ? null : { kind },
} })

import type { BotSubscriptionChoice } from './bot-model-choice'
import type { UsableApiKey } from './model-api-keys'
import { creditsOptionId } from './bot-model-menu-view'
import { SELF_HOSTED_DEFAULT_CATALOG_ID } from './model-gateway/config'

/** A Mikka 额度 pick (decision 2026-11-15-1900). */
const CREDITS_MODEL = 'deepseek/deepseek-v4-pro'
const CREDITS = creditsOptionId(CREDITS_MODEL)

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

test('hosted settings list the models offered by the configured LiteLLM source', async () => {
  const { readEnabledModels } = await import('./enabled-models')
  const query = { query: async (sql: string) => ({ rows: sql.includes('FROM "user"') ? [{ enabled: true }] : [] }) } as unknown as Pool
  const scope = { ownerId: 'fixture-owner', workspaceId: '10000000-0000-4000-8000-000000000001' }
  process.env.MIKKA_EDITION = 'community'
  try {
    assert.deepEqual((await readEnabledModels(query, scope)).sources.find(source => source.id === 'hosted')!.models.map(model => model.id), [SELF_HOSTED_DEFAULT_CATALOG_ID])
    kind = 'none'
    assert.deepEqual((await readEnabledModels(query, scope)).sources.find(source => source.id === 'hosted')!.models, [])
  } finally { kind = 'hosted'; process.env.MIKKA_EDITION = 'cloud' }
})

for (const source of ['selected', 'default'] as const) test(`a valid ${source} subscription does not query unrelated hosted policy`, async () => {
  const f = fixture('alice', [new Error('the unrelated hosted read must not run')])
  if (source === 'selected') f.state.selected = binding
  else f.state.own = [binding]
  const explicit = source === 'selected'
  const result = await choose(f, explicit ? { selected: binding.bindingId } : {})
  assert.deepEqual(result, { kind: 'subscription', binding, chosen: explicit })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 0)
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
  assert.deepEqual(await choose(f, { selected: CREDITS }), { kind: 'hosted', model: CREDITS_MODEL, chosen: true })
  assert.deepEqual(f.calls, ['hosted'])
  f.state.own = []
  // The source is off and nothing else can run: no model, so the chat asks for one.
  assert.deepEqual(await choose(f, { selected: CREDITS }), { kind: 'none', chosen: false, fallback: 'preference' })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 2, 'false is reused by both consumers; no cross-call cache')
  assert.equal(f.calls[1], 'hosted', 'the explicit choice still checks policy before reading subscriptions')
})

test('disabled explicit hosted choice keeps an available subscription fallback', async () => {
  const f = fixture('alice', [false])
  f.state.own = [binding]
  assert.deepEqual(await choose(f, { selected: CREDITS }), {
    kind: 'subscription', binding, chosen: false, fallback: 'preference',
  })
  assert.equal(f.calls[0], 'hosted')
  assert.equal(f.calls.filter(call => call === 'hosted').length, 1)
})

for (const kind of ['subscription', 'api_key'] as const) test(`no choice takes the ${kind} 优先使用的模型 names, without reading hosted policy`, async () => {
  const f = fixture('alice', [new Error('no Mikka 额度 is involved')])
  if (kind === 'subscription') {
    fallback = { kind, bindingId: binding.bindingId, model: binding.modelId }
    f.state.selected = binding
  } else fallback = { kind, keyId: key.id, model: 'gpt-6-luna' }
  assert.deepEqual(await choose(f, {}, [key]), kind === 'subscription'
    ? { kind: 'subscription', binding, chosen: false, fallback: 'preference' }
    : { kind: 'apiKey', key, model: 'gpt-6-luna', chosen: false, fallback: 'preference' })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 0)
  assert.equal(fallbackReads, 1)
})

test('no choice and nothing to fill in is no model, never a silent Mikka 额度 default', async () => {
  const f = fixture('alice', [new Error('no Mikka 额度 is involved')])
  assert.deepEqual(await choose(f), { kind: 'none', chosen: false })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 0)
  process.env.MIKKA_EDITION = 'community'
  const configured = kind
  try {
    // A self-hosted server offers only its administrator's model: with nothing to choose, a chat uses it.
    assert.deepEqual(await choose(fixture('alice', [true])), { kind: 'hosted', model: SELF_HOSTED_DEFAULT_CATALOG_ID, chosen: false })
    // A server with no model of its own still has no model to run.
    kind = 'none'
    assert.deepEqual(await choose(fixture('alice', [true])), { kind: 'none', chosen: false })
  } finally { process.env.MIKKA_EDITION = 'cloud'; kind = configured }
})

test('actual hosted policy failure on a Mikka 额度 pick propagates and the next invocation can recover', async () => {
  const failure = new Error('synthetic hosted policy read failure')
  const f = fixture('alice', [failure, true])
  await assert.rejects(choose(f, { selected: CREDITS }), error => error === failure)
  assert.equal(fallbackReads, 0)
  assert.deepEqual(await choose(f, { selected: CREDITS }), { kind: 'hosted', model: CREDITS_MODEL, chosen: true })
  assert.equal(f.calls.filter(call => call === 'hosted').length, 2)
})

test('concurrent owners do not share hosted policy and community servers still respect a disabled source', async () => {
  const alice = fixture('alice', [true]), bob = fixture('bob', [false])
  const [onAlice, onBob] = await Promise.all([choose(alice, { selected: CREDITS }), choose(bob, { selected: CREDITS })])
  assert.equal(onAlice.kind, 'hosted')
  assert.equal(onBob.kind, 'none')
  assert.equal(alice.calls.filter(call => call === 'hosted').length, 1)
  assert.equal(bob.calls.filter(call => call === 'hosted').length, 1)
  process.env.MIKKA_EDITION = 'community'
  try { assert.equal((await choose(fixture('alice', [false]), { selected: CREDITS })).kind, 'none') }
  finally { process.env.MIKKA_EDITION = 'cloud' }
})
