import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { hostedBillingScope } from './context'

const observations: unknown[] = []
mock.module(new URL('../execution-settings.ts', import.meta.url).href, { namedExports: {
  executionWorkspace: async (ownerId: string) => ownerId + '-workspace',
} })
mock.module(new URL('./model.ts', import.meta.url).href, { namedExports: {
  hostedModel: async () => ({
    async doGenerate() { await Promise.resolve(); observations.push(hostedBillingScope.getStore()); return { content: [] } },
    async doStream() { await Promise.resolve(); observations.push(hostedBillingScope.getStore()); return { stream: new ReadableStream({ start(c) { c.close() } }) } },
  }),
} })
mock.module(new URL('../workflow-run-failure.ts', import.meta.url).href, { namedExports: {
  workflowFailureCall: (start: () => unknown) => start(), workflowFailureStream: (start: () => unknown) => start(),
} })
const { HostedWorkflowModel } = await import('./workflow-model')

test('native durable model calls retain their authenticated owner and actor without inventing resource UUIDs', async () => {
  observations.length = 0
  await Promise.all([
    new HostedWorkflowModel('alice', null, 'fixture/model').doGenerate({ prompt: [] }),
    new HostedWorkflowModel('bob', null, 'fixture/model').doStream({ prompt: [] }),
  ])
  assert.deepEqual(observations, [
    { workspaceId: 'alice-workspace', ownerId: 'alice', actorId: 'alice' },
    { workspaceId: 'bob-workspace', ownerId: 'bob', actorId: 'bob' },
  ])
  assert.equal(hostedBillingScope.getStore(), undefined)
})
