import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'

import { createComposioAITools, createGoogleAITools, executeComposioAction, isApprovalAction, parseActionInput } from './composio-actions'
import type { ComposioActionClient } from './composio-actions'

const activeNotion = {
  id: 'notion-account',
  toolkit: { slug: 'notion' },
  status: 'ACTIVE',
  isDisabled: false,
}

function client(accounts: unknown[], calls: Record<string, unknown> = {}) {
  const fake = {
    connectedAccounts: {
      list: async (query: unknown) => {
        calls.accountQuery = query
        return { items: accounts, nextCursor: null }
      },
    },
    tools: {
      getRawComposioToolBySlug: async (slug: string) => {
        calls.toolSlug = slug
        return { version: '20261018_00' }
      },
      execute: async (slug: string, params: unknown) => {
        calls.execution = { slug, params }
        return { successful: true, error: null, data: { results: [] } }
      },
    },
  }

  return fake as unknown as ComposioActionClient
}

test('executes only for the signed-in user’s active, enabled account and pins its tool version', async () => {
  const calls: Record<string, unknown> = {}
  const result = await executeComposioAction(
    'user-1',
    'search_notion_pages',
    { query: 'roadmap', page_size: 5 },
    client([activeNotion], calls),
  )

  assert.deepEqual(result, { data: { results: [] }, accountId: 'notion-account' })
  assert.deepEqual(calls.accountQuery, {
    userIds: ['user-1'],
    toolkitSlugs: ['notion'],
    statuses: ['ACTIVE'],
    cursor: undefined,
  })
  assert.deepEqual(calls.execution, {
    slug: 'NOTION_SEARCH_NOTION_PAGE',
    params: {
      userId: 'user-1',
      connectedAccountId: 'notion-account',
      version: '20261018_00',
      arguments: { query: 'roadmap', page_size: 5 },
    },
  })
})

test('does not execute without an active, enabled connection or with invalid input', async () => {
  let executed = false
  const noAccounts = await executeComposioAction('user-1', 'search_notion_pages', { query: 'roadmap' }, client([
    { ...activeNotion, status: 'REVOKED' },
    { ...activeNotion, id: 'disabled-notion-account', isDisabled: true },
  ]))
  assert.deepEqual(noAccounts, { error: 'integrationNotConnected' })
  const noCalls = client([activeNotion], {})
  noCalls.tools.execute = async () => { executed = true; return { successful: true, error: null, data: {} } }
  const invalidInput = await executeComposioAction('user-1', 'search_notion_pages', { page_size: 0 }, noCalls)
  assert.deepEqual(invalidInput, { error: 'invalidIntegrationInput' })
  assert.equal(executed, false)
})

test('ambiguous or unavailable account never silently falls back to the oldest', async () => {
  const older = { ...activeNotion, id: 'older', alias: 'work', createdAt: '2026-09-01T00:00:00Z' }
  const newer = { ...activeNotion, id: 'newer', alias: 'personal', createdAt: '2026-10-01T00:00:00Z' }
  for (const chosen of [null, 'missing']) {
    const calls: Record<string, unknown> = {}
    const result = await executeComposioAction('user-1', 'search_notion_pages', { query: 'roadmap' }, client([older, newer], calls), async () => chosen)
    assert.deepEqual(result, { error: 'integrationAccountSelectionRequired', accounts: [{ id: 'older', alias: 'work' }, { id: 'newer', alias: 'personal' }] })
    assert.equal(calls.execution, undefined)
  }
  const calls: Record<string, unknown> = {}
  await executeComposioAction('user-1', 'search_notion_pages', { query: 'roadmap' }, client([older, newer], calls), async () => 'newer')
  assert.equal((calls.execution as { params: { connectedAccountId: string } }).params.connectedAccountId, 'newer')
  const unavailable = await executeComposioAction('user-1', 'search_notion_pages', { query: 'x' }, client([older]), async () => 'newer')
  assert.equal('error' in unavailable && unavailable.error, 'integrationAccountSelectionRequired')
})

test('rejects tool slugs outside Mikka’s fixed allowlist', async () => {
  const result = await executeComposioAction('user-1', 'NOTION_ARCHIVE_NOTION_PAGE' as never, {}, client([activeNotion]))
  assert.deepEqual(result, { error: 'integrationActionNotAllowed' })
})

function googleClient(toolkit: string, calls: Record<string, unknown>) {
  return client([{ id: `${toolkit}-account`, toolkit: { slug: toolkit }, status: 'ACTIVE', isDisabled: false }], calls)
}

test('sends an email as plain text to the first recipient plus the rest', async () => {
  const calls: Record<string, unknown> = {}
  await executeComposioAction('user-1', 'send_email', { to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'], subject: 'Hi', body: 'Hello' }, googleClient('gmail', calls))
  assert.deepEqual((calls.execution as { slug: string; params: { arguments: unknown } }).slug, 'GMAIL_SEND_EMAIL')
  assert.deepEqual((calls.execution as { params: { arguments: unknown } }).params.arguments, {
    recipient_email: 'a@example.com', extra_recipients: ['b@example.com'], cc: ['c@example.com'], subject: 'Hi', body: 'Hello', is_html: false,
  })
})

test('a lost response after an external write stays uncertain; preflight failures never dispatch', async () => {
  let effects = 0
  // Independent loopback effect service: this is a transport fault fixture,
  // not evidence that a live Gmail/Calendar account was exercised.
  const receiver = createServer((request, response) => {
    assert.equal(request.method, 'POST')
    effects++
    response.destroy()
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const address = receiver.address() as { port: number }
  try {
    for (const [action, toolkit, input] of [
      ['send_email', 'gmail', { to: ['recipient@example.invalid'], subject: 'Fixture', body: 'One effect' }],
      ['create_calendar_event', 'googlecalendar', { summary: 'Fixture', start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' }],
      ['update_calendar_event', 'googlecalendar', { event_id: 'fixture-event', summary: 'Fixture' }],
    ] as const) {
      const transport = googleClient(toolkit, {})
      transport.tools.execute = async () => {
        await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST' })
        throw Error('receiver must drop its response')
      }
      assert.deepEqual(await executeComposioAction('owner', action, input, transport), { error: 'operationUncertain' })
    }
    assert.equal(effects, 3, 'each invocation issues exactly one HTTP effect, without a transport retry')
    const transport = googleClient('gmail', {})
    transport.tools.getRawComposioToolBySlug = async () => { throw Error('metadata unavailable before dispatch') }
    assert.deepEqual(await executeComposioAction('owner', 'send_email', { to: ['recipient@example.invalid'], subject: 'Fixture', body: 'No dispatch' }, transport), { error: 'integrationActionFailed' })
    assert.equal(effects, 3)
  } finally {
    receiver.closeAllConnections()
    await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()))
  }
})

test('an unsuccessful dispatched write is unknown while an unsuccessful read remains a read error', async () => {
  const transport = googleClient('gmail', {})
  transport.tools.execute = async () => ({ successful: false, error: 'provider or gateway error', data: {}, logId: 'fixture-log' })
  assert.deepEqual(await executeComposioAction('owner', 'send_email', { to: ['recipient@example.invalid'], subject: 'Fixture', body: 'Fixture' }, transport), { error: 'operationUncertain', accountId: 'gmail-account', logId: 'fixture-log' })
  // The account it ran through, so a refused authorization can be marked on that account (lib/suggestions/reconcile.ts).
  assert.deepEqual(await executeComposioAction('owner', 'read_gmail_message', { message_id: 'fixture-id' }, transport), { error: 'provider or gateway error', accountId: 'gmail-account', logId: 'fixture-log' })
})

test('creates an event on the primary calendar without a Meet link, emailing guests unless told not to', async () => {
  const calls: Record<string, unknown> = {}
  await executeComposioAction('user-1', 'create_calendar_event', {
    summary: 'Review', start: '2026-10-27T10:00:00-07:00', end: '2026-10-27T10:30:00-07:00', attendees: ['a@example.com'],
  }, googleClient('googlecalendar', calls))
  assert.deepEqual((calls.execution as { params: { arguments: unknown } }).params.arguments, {
    calendar_id: 'primary', summary: 'Review', attendees: ['a@example.com'], start_datetime: '2026-10-27T10:00:00-07:00', end_datetime: '2026-10-27T10:30:00-07:00', send_updates: 'all', create_meeting_room: false,
  })
  const quiet = parseActionInput('create_calendar_event', { summary: 'Focus', start: '2026-10-27T10:00', end: '2026-10-27T11:00', timezone: 'America/Los_Angeles' })
  assert.ok(quiet)
})

test('an event change must change something and cannot cancel the event', () => {
  assert.equal(parseActionInput('update_calendar_event', { event_id: 'abc' }), null)
  assert.equal(parseActionInput('update_calendar_event', { event_id: 'abc', status: 'cancelled' }), null)
  assert.deepEqual(parseActionInput('update_calendar_event', { event_id: 'abc', start: '2026-10-27T11:00:00Z' }), { event_id: 'abc', start: '2026-10-27T11:00:00Z' })
})

test('only sending mail and writing the calendar are account writes', () => {
  assert.equal(isApprovalAction('send_email'), true)
  assert.equal(isApprovalAction('create_calendar_event'), true)
  assert.equal(isApprovalAction('update_calendar_event'), true)
  assert.equal(isApprovalAction('list_calendar_events'), false)
  assert.equal(isApprovalAction('fetch_recent_gmail'), false)
})


test('bound actions never follow a changed default or use a disabled, missing, or wrong-toolkit account', async () => {
  const older = { ...activeNotion, id: 'older', createdAt: '2026-09-01T00:00:00Z' }
  const newer = { ...activeNotion, id: 'newer', createdAt: '2026-10-01T00:00:00Z' }
  const calls: Record<string, unknown> = {}
  await executeComposioAction('user-1', 'search_notion_pages', { query: 'x' }, client([older, newer], calls), async () => 'newer', 'older')
  assert.equal((calls.execution as { params: { connectedAccountId: string } }).params.connectedAccountId, 'older')
  for (const accounts of [[newer], [{ ...older, isDisabled: true }, newer], [{ ...older, toolkit: { slug: 'gmail' } }, newer]]) {
    const attempted: Record<string, unknown> = {}
    const result = await executeComposioAction('user-1', 'search_notion_pages', { query: 'x' }, client(accounts, attempted), async () => 'newer', 'older')
    assert.equal('error' in result && result.error, 'integrationAccountSelectionRequired')
    assert.equal(attempted.execution, undefined)
  }
})


test('model tools pass explicit account choices separately from provider input', async () => {
  const calls: unknown[][] = []
  const call = async (...args: unknown[]) => { calls.push(args); return {} }
  const notion = createComposioAITools(call)
  const google = createGoogleAITools(call, call)
  const options = { toolCallId: 'synthetic', messages: [], context: {} }
  await notion.search_notion_pages.execute!({ query: 'roadmap', account_id: 'account-a' }, options)
  await google.send_email.execute!({ to: ['test@example.invalid'], subject: 's', body: 'b', account_id: 'account-b' }, options)
  assert.deepEqual(calls, [['search_notion_pages', { query: 'roadmap' }, 'account-a'], ['send_email', { to: ['test@example.invalid'], subject: 's', body: 'b' }, 'account-b']])
})

test('the dispatch gate sees the account and tool tags before anything is sent, and can stop it', async () => {
  const calls: Record<string, unknown> = {}
  const transport = client([activeNotion], calls)
  transport.tools.getRawComposioToolBySlug = async () => ({ version: '20261018_00', tags: ['destructiveHint'] }) as never
  const seen: unknown[] = []
  const stopped = await executeComposioAction('user-1', 'search_notion_pages', { query: 'x' }, transport, undefined, undefined, async (accountId, tool) => { seen.push([accountId, tool.tags]); return { error: 'integrationApprovalRequired' } })
  assert.deepEqual(stopped, { error: 'integrationApprovalRequired' })
  assert.deepEqual(seen, [['notion-account', ['destructiveHint']]])
  assert.equal(calls.execution, undefined)
  const passed = await executeComposioAction('user-1', 'search_notion_pages', { query: 'x' }, transport, undefined, undefined, async () => null)
  assert.ok('data' in passed)
  assert.ok(calls.execution)
})
