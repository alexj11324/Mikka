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
