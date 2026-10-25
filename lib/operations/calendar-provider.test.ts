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

for (const action of ['send_email', 'update_calendar_event'] as const) test(`${action}: pinned toolkit/version, approved arguments, preflight fence and unknown receipts`, async () => {
  const toolkit = action === 'send_email' ? 'gmail' : 'googlecalendar'
  const writes: { slug: string; params: Record<string, unknown> }[] = []
  let checks = 0, noReceipt = false
  const client = {
    connectedAccounts: { async list(args: { toolkitSlugs: string[] }) { assert.deepEqual(args.toolkitSlugs, [toolkit]); return { items: [{ id: 'pinned', toolkit: { slug: toolkit }, status: 'ACTIVE', isDisabled: false }] } } },
    tools: {
      async getRawComposioToolBySlug() { return { version: 'fixed-v1' } },
      async execute(slug: string, params: Record<string, unknown>, options?: { beforeExecute: (v: unknown) => Promise<unknown> }) {
        assert.equal(params.connectedAccountId, 'pinned'); assert.equal(params.version, 'fixed-v1')
        if (slug === 'GOOGLECALENDAR_EVENTS_GET') { assert.deepEqual(params.arguments, { calendar_id: 'primary', event_id: 'event-existing' }); return { successful: true, data: { id: 'event-existing', summary: 'Before approval' } } }
        assert.ok(options); await options.beforeExecute({ params }); writes.push({ slug, params })
        return { successful: true, data: noReceipt ? {} : { id: action === 'send_email' ? 'message-receipt' : 'event-existing' } }
      },
    },
  } as unknown as ComposioActionClient
  const provider = composioCalendarProvider(client, action)
  const payload = action === 'send_email' ? { to: ['fixture@example.invalid'], subject: 'Synthetic', body: 'Synthetic body' } : { event_id: 'event-existing', summary: 'After approval', notify_attendees: false }
  const selected = await provider.prepare('fixture', payload)
  assert.equal(writes.length, 0, 'proposing never executes a mutating tool')
  if (action === 'update_calendar_event') assert.equal(selected.context?.summary, 'Before approval')
  const args = { ownerId: 'fixture', accountId: selected.accountId, version: selected.version, payload, idempotencyKey: 'stable', signal: new AbortController().signal, beforeSend: async () => { checks++ } }
  assert.ok((await provider.execute(args)).providerObjectId)
  assert.equal(checks, 2); assert.equal(writes.length, 1)
  assert.equal(writes[0].slug, action === 'send_email' ? 'GMAIL_SEND_EMAIL' : 'GOOGLECALENDAR_PATCH_EVENT')
  assert.deepEqual(writes[0].params.arguments, action === 'send_email' ? { recipient_email: 'fixture@example.invalid', extra_recipients: [], subject: 'Synthetic', body: 'Synthetic body', is_html: false } : { calendar_id: 'primary', event_id: 'event-existing', summary: 'After approval', send_updates: 'none' })
  assert.equal(await provider.lookup({ ownerId: 'fixture', accountId: 'pinned', idempotencyKey: 'stable' }), null)
  noReceipt = true
  await assert.rejects(provider.execute(args), /operationUncertain/)
})
