import assert from 'node:assert/strict'
import test from 'node:test'

import { executeComposioAction } from './composio-actions'
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

  assert.deepEqual(result, { data: { results: [] } })
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

test('does not execute if no active connection exists or the toolkit has multiple accounts', async () => {
  let executed = false
  const noAccounts = await executeComposioAction('user-1', 'search_notion_pages', { query: 'roadmap' }, client([
    { ...activeNotion, status: 'REVOKED' },
    { ...activeNotion, id: 'disabled-notion-account', isDisabled: true },
  ]))
  const multipleAccounts = await executeComposioAction('user-1', 'search_notion_pages', { query: 'roadmap' }, client([
    activeNotion,
    { ...activeNotion, id: 'second-notion-account' },
  ]))

  assert.deepEqual(noAccounts, { error: 'integrationNotConnected' })
  assert.deepEqual(multipleAccounts, { error: 'integrationMultipleAccounts' })
  const noCalls = client([activeNotion], {})
  noCalls.tools.execute = async () => { executed = true; return { successful: true, error: null, data: {} } }
  const invalidInput = await executeComposioAction('user-1', 'search_notion_pages', { page_size: 0 }, noCalls)
  assert.deepEqual(invalidInput, { error: 'invalidIntegrationInput' })
  assert.equal(executed, false)
})

test('rejects tool slugs outside Mikka’s fixed allowlist', async () => {
  const result = await executeComposioAction('user-1', 'NOTION_ARCHIVE_NOTION_PAGE' as never, {}, client([activeNotion]))
  assert.deepEqual(result, { error: 'integrationActionNotAllowed' })
})
