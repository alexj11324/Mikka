import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { builtinAgentDefinition } from './builtin'

const owner = 'synthetic-owner', bot = '10000000-0000-4000-8000-000000000001'
const profile = builtinAgentDefinition({computerEnabled: true})
const calls: {name: string; args: unknown[]}[] = []
let enabled = true
const record = (name: string, ...args: unknown[]) => calls.push({name, args})
const forbidden = () => { throw Error('No model, database or native device in default-consumer test') }
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, {namedExports})
stub('./service.ts', {
  agentKitEnabled: () => enabled,
  agentKitDefaults: () => { record('defaults'); return profile },
  agentScope: async (...args: unknown[]) => { record('scope', ...args); return {ownerId: owner, botId: args[1], workspaceId: null} },
  agentKitStore: {
    active: async (...args: unknown[]) => { record('active', ...args); return {definition: args[1], version: 1} },
    beginExecution: async (...args: unknown[]) => { record('begin', ...args); return null },
  },
})
stub('../auth.ts', {auth: {api: {getSession: async () => ({user: {id: owner}})}}})
stub('./live-eval.ts', {evaluateProposal: forbidden})
stub('../subscription-runtime.ts', {authorizeSubscriptionWorkspace: forbidden, subscriptionRuntime: forbidden})
stub('../coordinator/bot-instructions.ts', {botInstructions: async () => 'synthetic host'})
stub('../coordinator/personal-instructions.ts', { withPersonalInstructions: async (_owner: string, base: string) => base })
stub('../coordinator/instructions.ts', {COORDINATOR_INSTRUCTIONS: 'synthetic host'})
stub('../coordinator/native-prompt.ts', {personalCoordinatorInstructions: () => 'synthetic native host'})
stub('../../workflows/coordinator/tool-scope.ts', {assertNativeToolScope: forbidden})
/** The person's Coordinator, an ordinary bot row; the definition API still names it 'coordinator'. */
const coordinatorBot = '20000000-0000-4000-8000-0000000c0de1'
let route: typeof import('../../app/api/bots/[botId]/definition/route')
let steps: typeof import('../../workflows/coordinator/agent-kit-steps')
before(async () => {
  route = await import('../../app/api/bots/[botId]/definition/route')
  steps = await import('../../workflows/coordinator/agent-kit-steps')
})

test('actual definition API seeds a new scope with the host-resolved conditional profile', async () => {
  calls.length = 0
  const response = await route.GET(new Request('https://example.test/api/bots/coordinator/definition'), {params: Promise.resolve({botId: 'coordinator'})})
  assert.equal(response.status, 200)
  assert.deepEqual(calls.find(call => call.name === 'scope')?.args, [owner, null])
  assert.equal(calls.find(call => call.name === 'active')?.args[1], profile)
  assert.deepEqual((await response.json()).definition, profile)
})

test('actual SDK and native execution reservations use the same resolved defaults', async () => {
  for (const runtime of [{harness: 'ai_sdk' as const}, {harness: 'claude_code' as const, deviceId: bot}, {harness: 'codex' as const, deviceId: bot}]) {
    calls.length = 0
    await steps.beginAgentExecution(owner, coordinatorBot, 'synthetic-holder', 0, runtime)
    assert.equal(calls.filter(call => call.name === 'defaults').length, 1)
    assert.equal(calls.find(call => call.name === 'begin')?.args[4], profile)
    assert.deepEqual(calls.find(call => call.name === 'scope')?.args, [owner, coordinatorBot])
  }
})

test('disabled API and execution paths never initialize a version or touch scope, store or model', async () => {
  enabled = false
  try {
    calls.length = 0
    const response = await route.GET(new Request('https://example.test/api/bots/coordinator/definition'), {params: Promise.resolve({botId: 'coordinator'})})
    assert.equal(response.status, 404)
    assert.equal(await steps.beginAgentExecution(owner, coordinatorBot, 'synthetic-holder', 0, {harness: 'ai_sdk'}), null)
    assert.equal(calls.length, 0)
  } finally { enabled = true }
})
