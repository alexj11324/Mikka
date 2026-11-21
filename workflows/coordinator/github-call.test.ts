import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

// Verify the registry forwards the person's identity and exact tool call to GitHub.
const calls: unknown[][] = []
mock.module(new URL('./steps.ts', import.meta.url).href, {
  namedExports: {
    githubMcp: async (...args: unknown[]) => {
      calls.push(args)
      return { error: 'githubReconnectRequired' }
    },
  },
})

let registry: typeof import('./tools')
before(async () => { registry = await import('./tools') })

const bot = '00000000-0000-4000-8000-000000000001'
const call = () => registry.createCoordinatorRegistry('owner', bot).github_call!.execute!(
  { name: 'list_issues', arguments: {} },
  { toolCallId: 'call-1', messages: [], context: {} } as never,
)

test('GitHub MCP uses the caller’s authorization and preserves the provider result', async () => {
  assert.deepEqual(await call(), { error: 'githubReconnectRequired' })
  assert.deepEqual(calls, [['owner', { name: 'list_issues', arguments: {} }, undefined]])
})
