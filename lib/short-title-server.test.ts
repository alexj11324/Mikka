import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const admitted: unknown[] = [], selected: unknown[] = []
mock.module(new URL('./abuse/model.ts', import.meta.url).href, { namedExports: {
  admitHostedModel: async (...args: unknown[]) => { admitted.push(args) },
  hostedModel: async (...args: unknown[]) => { selected.push(args); return { modelId: args[1] } },
} })
mock.module('ai', { namedExports: {
  generateText: async ({ model }: { model: { modelId: string } }) => {
    assert.equal(model.modelId, 'mikka-title')
    return { text: JSON.stringify({ title: 'Fix login' }) }
  },
} })

test('short titles admit and use the managed title alias', async () => {
  const { generateShortTitle } = await import('./short-title-server')
  assert.equal(await generateShortTitle('owner', { title: 'Fix login', body: '' }, 'workspace'), 'Fix login')
  assert.deepEqual(admitted, [[{ workspaceId: 'workspace', ownerId: 'owner' }, 'mikka-title', { auditAllowed: false }]])
  assert.deepEqual(selected, [['workspace', 'mikka-title', undefined, 'owner']])
})
