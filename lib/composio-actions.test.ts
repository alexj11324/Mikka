import assert from 'node:assert/strict'
import test from 'node:test'

import { executeComposioAction, isApprovalAction, parseActionInput } from './composio-actions'
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

test('with several accounts, runs as the chosen default, else the oldest usable one', async () => {
  const older = { ...activeNotion, id: 'older', createdAt: '2026-09-01T00:00:00Z' }
  const newer = { ...activeNotion, id: 'newer', createdAt: '2026-10-01T00:00:00Z' }
  const accountUsed = async (accounts: unknown[], chosen: string | null) => {
    const calls: Record<string, unknown> = {}
    const asked: string[] = []
    await executeComposioAction('user-1', 'search_notion_pages', { query: 'roadmap' }, client(accounts, calls), async toolkit => { asked.push(toolkit); return chosen })
    return { id: (calls.execution as { params: { connectedAccountId: string } }).params.connectedAccountId, asked }
  }
  assert.deepEqual(await accountUsed([newer, older], 'newer'), { id: 'newer', asked: ['notion'] })
  assert.deepEqual(await accountUsed([newer, older], null), { id: 'older', asked: ['notion'] })
  // A chosen default that is switched off falls back to the oldest usable account.
  assert.deepEqual(await accountUsed([{ ...newer, isDisabled: true }, older], 'newer'), { id: 'older', asked: ['notion'] })
  // One account needs no lookup.
  assert.deepEqual(await accountUsed([newer], null), { id: 'newer', asked: [] })
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

test('only sending mail and writing the calendar need approval', () => {
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
    assert.deepEqual(result, { error: 'integrationNotConnected' })
    assert.equal(attempted.execution, undefined)
  }
})
