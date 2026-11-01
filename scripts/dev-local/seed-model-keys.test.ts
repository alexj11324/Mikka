import assert from 'node:assert/strict'
import test from 'node:test'
import { preferredModel, seedModelKeys, type SeedDeps } from './seed-model-keys'

function fake(owners: string[]) {
  const keyed = new Set<string>()
  const choices: string[] = []
  const deps: SeedDeps = {
    ownersWithoutKey: async () => owners.filter(owner => !keyed.has(owner)),
    addKey: async owner => { keyed.add(owner); return { id: `key-${owner}`, models: ['deepseek-chat', 'deepseek-v4.1-flash', 'deepseek-v4-pro'] } },
    scopes: async () => [{ workspaceId: 'ws-1', botIds: ['bot-1', null] }],
    choose: async (scope, botId, keyId, model) => { choices.push(`${scope.ownerId}/${botId ?? 'coordinator'}=${keyId}:${model}`) },
  }
  return { deps, choices }
}

test('seeds each account once, on the preferred model, and is idempotent', async () => {
  const { deps, choices } = fake(['u1', 'u2'])
  assert.equal(await seedModelKeys('sk-test', deps), 2)
  assert.equal(await seedModelKeys('sk-test', deps), 0)
  assert.deepEqual(choices, ['u1/bot-1=key-u1:deepseek-v4.1-flash', 'u1/coordinator=key-u1:deepseek-v4.1-flash', 'u2/bot-1=key-u2:deepseek-v4.1-flash', 'u2/coordinator=key-u2:deepseek-v4.1-flash'])
})

test('without a key nothing is seeded', async () => {
  const { deps, choices } = fake(['u1'])
  assert.equal(await seedModelKeys(undefined, deps), 0)
  assert.deepEqual(choices, [])
})

test('the preferred model falls back in order', () => {
  assert.equal(preferredModel(['a', 'deepseek-flash']), 'deepseek-flash')
  assert.equal(preferredModel(['x', 'y']), 'x')
  assert.equal(preferredModel([]), undefined)
})

test('the loop refuses to run outside dev:local', async () => {
  const { assertDevLocal } = await import('./guard.mjs')
  assert.throws(() => assertDevLocal({ MIKKA_LOCAL_TEST_ACCOUNTS: '1' }), /dev:local needs/)
  assert.throws(() => assertDevLocal({ MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: 'postgres://a:b@127.0.0.1/x_e2e', VERCEL_ENV: 'preview' }), /dev:local needs/)
})
