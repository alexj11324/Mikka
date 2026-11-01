import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { makeSnapshot } from './definition'
import { DEFAULT_AGENT_DEFINITION } from './builtin'
import type { AgentExecution } from './store'
/** The person's Coordinator: an ordinary bot row, marked as the Coordinator. */
const COORDINATOR_BOT = '00000000-0000-4000-8000-0000000c0de1'
const calls: unknown[][] = [], hooks: unknown[][] = []
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../../workflows/coordinator/steps.ts', { personalMailbox: async (...args: unknown[]) => { calls.push(args); return { self: 'bound' } } })
stub('../../workflows/coordinator/agent-kit-steps.ts', { beforeAgentTool: async (...args: unknown[]) => { hooks.push(args) }, afterAgentTool: async (...args: unknown[]) => { hooks.push(args) } })
stub('../composio-actions.ts', { createComposioAITools: () => ({}), createGoogleAITools: () => ({}) })
let registry: typeof import('../../workflows/coordinator/tools')
before(async () => { registry = await import('../../workflows/coordinator/tools') })
const execution = (tools: string[]): AgentExecution => ({ id: '28700000-0000-4000-8000-000000000001', status: 'running', snapshot: makeSnapshot('28700000-0000-4000-8000-000000000002', 1, { ...DEFAULT_AGENT_DEFINITION, tools }, 'HOST', { harness: 'ai_sdk', model: 'synthetic' }) })
test('all eight named execution/computer/mailbox combinations preserve independent capabilities and frozen hooks', async () => {
  for (const hasExecution of [false, true]) for (const computerEnabled of [false, true]) for (const mailboxEnabled of [false, true]) {
    const e = hasExecution ? execution([...(computerEnabled ? ['dispatch_bot_computer'] : []), ...(mailboxEnabled ? ['mailbox_inbox'] : [])]) : undefined
    const scope = { holder: 'holder', turnId: 'turn', callId: 'call' }
    const tools = registry.coordinatorTools('owner', COORDINATOR_BOT, scope, { coordinator: true,  execution: e, computerEnabled, mailboxEnabled, mailboxTools: mailboxEnabled ? ['mailbox_inbox'] : [] })
    assert.equal(Boolean(tools.mailbox_inbox), hasExecution && mailboxEnabled)
    assert.equal(Boolean(tools.dispatch_bot_computer), computerEnabled)
    assert.equal(Boolean(tools.mailbox_send), false)
    if (tools.mailbox_inbox) {
      await tools.mailbox_inbox.execute!({}, { toolCallId: 'call', messages: [], context: undefined })
      assert.deepEqual(calls.at(-1), ['owner', COORDINATOR_BOT, { action: 'inbox' }, scope, e!.id])
      assert.equal(hooks.at(-2)?.[2], e!.id); assert.equal(hooks.at(-1)?.[4], 'mailbox_inbox')
    }
  }
})
test('replay keeps its original catalogue; host flag cannot expand old effectiveTools or erase snapshot identity', () => {
  const old = execution(['list_runs']), raw = JSON.stringify(old)
  const tools = registry.coordinatorTools('owner', COORDINATOR_BOT, undefined, { coordinator: true,  execution: old, mailboxEnabled: true })
  assert.deepEqual(Object.keys(tools), ['list_runs'])
  assert.equal(JSON.stringify(old), raw)
  assert.deepEqual(Object.keys(registry.coordinatorTools('owner', COORDINATOR_BOT, undefined, { coordinator: true,  execution: execution(['mailbox_inbox']), mailboxEnabled: false })), [])
  assert.deepEqual(Object.keys(registry.coordinatorTools('owner', COORDINATOR_BOT, undefined, { coordinator: true,  execution: execution(['mailbox_inbox']), mailboxEnabled: true })), [], 'Missing current host catalogue is not an implicit grant')
  const constrained = registry.coordinatorTools('owner', COORDINATOR_BOT, undefined, { coordinator: true,  execution: execution(['mailbox_inbox', 'mailbox_send', 'list_runs']), mailboxEnabled: true, mailboxTools: ['mailbox_inbox'] })
  assert.deepEqual(Object.keys(constrained), ['mailbox_inbox', 'list_runs'])
})
