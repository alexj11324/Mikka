import assert from 'node:assert/strict'
import test from 'node:test'
import type { ComposioActionClient } from '../composio-actions'
import { composioCalendarProvider } from './calendar-provider'

test('an aborted account lookup never resumes into a provider write', async () => {
  let release!: () => void, writes = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const client = {
    connectedAccounts: { async list() { await gate; return { items: [{ id: 'bound', toolkit: { slug: 'googlecalendar' }, status: 'ACTIVE', isDisabled: false }] } } },
    tools: { async execute() { writes++; return { successful: true, data: { id: 'unwanted' } } } },
  } as unknown as ComposioActionClient
  const controller = new AbortController()
  const result = composioCalendarProvider(client).execute({ ownerId: 'fixture', accountId: 'bound', version: 'v1', payload: {}, idempotencyKey: 'fixture', signal: controller.signal, beforeSend: async () => {} })
  controller.abort(); release()
  await assert.rejects(result, /abort/i)
  assert.equal(writes, 0)
})

test('SDK pre-send hook rechecks authority after internal schema preflight', async () => {
  let expired = false, writes = 0, authorityChecks = 0
  const client = {
    connectedAccounts: { async list() { return { items: [{ id: 'bound', toolkit: { slug: 'googlecalendar' }, status: 'ACTIVE', isDisabled: false }] } } },
    tools: { async execute(_slug: string, params: unknown, options: { signal: AbortSignal; beforeExecute: (context: unknown) => Promise<unknown> }) {
      assert.ok(options.signal)
      expired = true // delayed SDK schema resolution crossed the authority deadline
      await options.beforeExecute({ params })
      writes++; return { successful: true, data: { id: 'unwanted' } }
    } },
  } as unknown as ComposioActionClient
  await assert.rejects(composioCalendarProvider(client).execute({ ownerId: 'fixture', accountId: 'bound', version: 'v1', payload: {}, idempotencyKey: 'fixture', signal: new AbortController().signal, beforeSend: async () => { authorityChecks++; if (expired) throw new Error('authority expired') } }), /authority expired/)
  assert.equal(authorityChecks, 2); assert.equal(writes, 0)
})
