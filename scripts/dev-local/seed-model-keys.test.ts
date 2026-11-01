import assert from 'node:assert/strict'
import test from 'node:test'
import { preferredModel, seedModelKeys, type SeedDeps, type SeedState } from './seed-model-keys'

function fake(owners: string[]) {
  const keys = new Map<string, { id: string; models: string[] }>()
  const pending = new Map(owners.map(owner => [owner, ['bot-1', null] as (string | null)[]]))
  const choices: string[] = []
  let additions = 0
  const deps: SeedDeps = {
    owners: async () => owners.map(ownerId => ({ ownerId, key: keys.get(ownerId) })),
    addKey: async owner => { additions++; const key = { id: `key-${owner}`, models: ['deepseek-chat', 'deepseek-v4.1-flash', 'deepseek-v4-pro'] }; keys.set(owner, key); return key },
    scopes: async owner => pending.get(owner)?.length ? [{ workspaceId: 'ws-1', botIds: [...pending.get(owner)!] }] : [],
    choose: async (scope, botId, keyId, model) => {
      choices.push(`${scope.ownerId}/${botId ?? 'coordinator'}=${keyId}:${model}`)
      pending.set(scope.ownerId, pending.get(scope.ownerId)!.filter(id => id !== botId))
    },
  }
  return { deps, choices, pending, additions: () => additions }
}

test('seeds each account once and covers bots created after the key', async () => {
  const { deps, choices, pending, additions } = fake(['u1', 'u2'])
  assert.equal(await seedModelKeys('sk-test', deps), 2)
  assert.equal(await seedModelKeys('sk-test', deps), 0)
  assert.equal(choices.length, 4)
  pending.set('u1', ['later-bot'])
  await seedModelKeys('sk-test', deps)
  assert.equal(choices.at(-1), 'u1/later-bot=key-u1:deepseek-v4.1-flash')
  assert.equal(additions(), 2)
})

test('one provider failure does not block later owners and backs off', async () => {
  const { deps, choices, additions } = fake(['bad', 'good'])
  const add = deps.addKey
  let attempts = 0
  deps.addKey = async (owner, key) => { if (owner === 'bad') { attempts++; throw new Error(`Authorization: ${key}`) }; return add(owner, key) }
  const state: SeedState = new Map()
  const messages: string[] = []
  await seedModelKeys('secret-test', deps, line => messages.push(line), state, () => 0)
  await seedModelKeys('secret-test', deps, line => messages.push(line), state, () => 5000)
  assert.equal(attempts, 1)
  assert.equal(additions(), 1)
  assert.equal(choices.length, 2)
  assert.ok(messages.every(line => !line.includes('secret-test')))
  await seedModelKeys('secret-test', deps, () => {}, state, () => 30_000)
  assert.equal(attempts, 2)
  assert.equal(state.get('bad')?.retryAt, 90_000)
})

test('a model choice failure reuses the stored key on retry', async () => {
  const { deps, additions } = fake(['u1'])
  const choose = deps.choose
  let failed = false
  deps.choose = async (...args) => { if (!failed) { failed = true; throw new Error('temporary') }; await choose(...args) }
  const state: SeedState = new Map()
  await seedModelKeys('test', deps, () => {}, state, () => 0)
  await seedModelKeys('test', deps, () => {}, state, () => 30_000)
  assert.equal(additions(), 1)
  assert.equal(state.size, 0)
})

test('without a key nothing is seeded; local acceptance never falls back to chat', async () => {
  const { deps, choices } = fake(['u1'])
  assert.equal(await seedModelKeys(undefined, deps), 0)
  assert.deepEqual(choices, [])
  assert.equal(preferredModel(['a', 'deepseek-flash']), 'deepseek-flash')
  assert.equal(preferredModel(['deepseek-chat']), undefined)
  assert.equal(preferredModel([]), undefined)
})

test('the loop refuses to run outside dev:local', async () => {
  const { assertDevLocal } = await import('./guard.mjs')
  assert.throws(() => assertDevLocal({ MIKKA_LOCAL_TEST_ACCOUNTS: '1' }), /dev:local needs/)
  assert.throws(() => assertDevLocal({ MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: 'postgres://a:b@127.0.0.1/x_e2e', VERCEL_ENV: 'preview' }), /dev:local needs/)
})
