import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'

const actor = { userId: 'owner', workspaceId: 'workspace' }
const invocations: Record<string, unknown>[] = []
const updates: unknown[] = []
let resultStatus: 'session_applied' | 'submitted' = 'submitted'
let currentLoader = 'document'
let targetIdentity: unknown = 42
let modelAction: 'login' | 'waiting' = 'login'
let modelSelector = '[data-mikka-ref="1"]'
const oldVisionModel = process.env.MIKKA_BROWSER_VISION_MODEL
class FakeStore {
  async start() { return { status: 'running', epoch: 7, task: 'Sign in', step: 'start' } }
  async action(_actor: unknown, _bot: string, _id: string, action: { action: string }) {
    if (action.action === 'observe') return { loaderId: 'document', screenshot: '/9j/2Q==', targets: { '1': targetIdentity }, observation: { url: 'https://example.test/login', elements: [{ selector: '[data-mikka-ref="1"]' }] } }
    if (action.action === 'inspectMutation') return { loaderId: currentLoader, origin: 'https://example.test' }
    throw new Error('unexpected action')
  }
  async update(...args: unknown[]) { updates.push(args) }
}
mock.module(new URL('../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: { query: async () => ({ rowCount: 0 }) }, db: {} } })
mock.module(new URL('../../lib/cloud-computer/subagents.ts', import.meta.url).href, { namedExports: { SubagentStore: FakeStore } })
mock.module(new URL('../../lib/cloud-computer/credential-consumer.ts', import.meta.url).href, { namedExports: { executeCredentialIntent: async (input: Record<string, unknown>) => { invocations.push(input); return { status: resultStatus } } } })
mock.module(new URL('../../lib/coordinator-event-store.ts', import.meta.url).href, { namedExports: { recordCoordinatorEvent: async () => {} } })
mock.module(new URL('../../lib/coordinator/wake.ts', import.meta.url).href, { namedExports: { wakeCoordinator: async () => {} } })
mock.module('ai', { namedExports: { tool: (input: unknown) => input, generateText: async () => ({ toolCalls: [{ toolName: 'choose_browser_action', input: { action: modelAction, selector: modelSelector, loginRole: 'username', step: 'Login', summary: 'Please take over' } }] }) } })
let tick: typeof import('./steps').tick
before(async () => { process.env.MIKKA_BROWSER_VISION_MODEL = 'synthetic/test'; tick = (await import('./steps')).tick })
after(() => { if (oldVisionModel === undefined) delete process.env.MIKKA_BROWSER_VISION_MODEL; else process.env.MIKKA_BROWSER_VISION_MODEL = oldVisionModel })
beforeEach(() => { invocations.length = 0; updates.length = 0; currentLoader = 'document'; targetIdentity = 42; modelAction = 'login'; modelSelector = '[data-mikka-ref="1"]' })

for (const status of ['session_applied', 'submitted'] as const) {
  test(`${status} preserves selected target and requires another observation`, async () => {
    resultStatus = status
    assert.equal(await tick(actor, 'bot', 'subagent'), 'running')
    assert.deepEqual(invocations, [{ permissionAction: 'computer_use', actor, botId: 'bot', subagentId: 'subagent', epoch: 7, loaderId: 'document', origin: 'https://example.test', backendNodeId: 42, intent: { targetSelector: '[data-mikka-ref="1"]', role: 'username' } }])
    assert.equal(updates.length, 0)
  })
}

test('a changed document never reaches the credential broker', async () => {
  currentLoader = 'different-document'
  assert.equal(await tick(actor, 'bot', 'subagent'), 'terminal')
  assert.equal(invocations.length, 0)
})

test('a missing or invalid node identity never reaches the credential broker', async () => {
  targetIdentity = 0
  assert.equal(await tick(actor, 'bot', 'subagent'), 'terminal')
  assert.equal(invocations.length, 0)
})

test('model requests human takeover without invoking credential service', async () => {
  modelAction = 'waiting'
  assert.equal(await tick(actor, 'bot', 'subagent'), 'waiting')
  assert.equal(invocations.length, 0)
})

test('model cannot submit an arbitrary selector or script to the credential service', async () => {
  modelSelector = '[data-mikka-ref="1"];alert(1)'
  assert.equal(await tick(actor, 'bot', 'subagent'), 'terminal')
  assert.equal(invocations.length, 0)
})
