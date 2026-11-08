import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { Pool } from 'pg'
import { COORDINATOR_MODEL } from './coordinator/model'
let kind = 'self-hosted', targetReads = 0
mock.module(new URL('./default-model.ts', import.meta.url).href, { namedExports: {
  defaultModelTarget: async () => { targetReads++; return { kind, serviceUrl: 'https://cloud.example.invalid' } },
} })

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
