import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

// The registry path: github_call asks a durable step for the workspace/Bot policy
// before it reaches GitHub. The step is stubbed so this stays source-only.
type Policy = 'allow' | 'deny' | 'unavailable'
const state = { policy: 'allow' as Policy, mcpCalls: 0, gateCalls: [] as string[] }

mock.module(new URL('./steps.ts', import.meta.url).href, {
  namedExports: {
    githubCallAllowedStep: async (userId: string, botId: string | null) => {
      state.gateCalls.push(`${userId}:${botId}`)
      return state.policy
    },
    githubMcp: async () => {
      state.mcpCalls++
      return { tools: [{ name: 'list_issues' }] }
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

test('a denied policy returns githubActionDenied without reaching GitHub', async () => {
  state.policy = 'deny'; state.mcpCalls = 0; state.gateCalls.length = 0
  assert.deepEqual(await call(), { error: 'githubActionDenied' })
  assert.equal(state.mcpCalls, 0)
  assert.deepEqual(state.gateCalls, [`owner:${bot}`], 'the gate reads this owner and Bot')
})

test('an unreadable policy returns githubPolicyUnavailable, not a denial', async () => {
  state.policy = 'unavailable'; state.mcpCalls = 0
  assert.deepEqual(await call(), { error: 'githubPolicyUnavailable' })
  assert.equal(state.mcpCalls, 0)
})

test('an allowed policy reaches the GitHub MCP step', async () => {
  state.policy = 'allow'; state.mcpCalls = 0
  assert.deepEqual(await call(), { tools: [{ name: 'list_issues' }] })
  assert.equal(state.mcpCalls, 1)
})
