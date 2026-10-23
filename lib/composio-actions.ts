import type { Composio } from '@composio/core'
import { tool } from 'ai'
import { z } from 'zod'

import { listComposioPages } from '@/lib/composio-pagination'

export const COMPOSIO_ACTIONS = {
  search_notion_pages: {
    title: 'Search Notion pages',
    description: 'Search the connected Notion workspace for pages and databases by title.',
    toolkit: 'notion',
    slug: 'NOTION_SEARCH_NOTION_PAGE',
    inputSchema: z.object({ query: z.string().trim().min(1).max(200), page_size: z.number().int().min(1).max(100).optional(), start_cursor: z.string().max(500).optional() }),
  },
  read_notion_page_blocks: {
    title: 'Read Notion page blocks',
    description: 'Read the immediate child blocks of a Notion page or block. Use returned block IDs to read nested content.',
    toolkit: 'notion',
    slug: 'NOTION_FETCH_BLOCK_CONTENTS',
    inputSchema: z.object({ block_id: z.string().trim().min(1).max(255), page_size: z.number().int().min(1).max(100).optional(), start_cursor: z.string().max(500).optional() }),
  },
  search_slack_messages: {
    title: 'Search Slack messages',
    description: 'Search messages visible to the connected Slack account. Use page for manual pagination.',
    toolkit: 'slack',
    slug: 'SLACK_SEARCH_MESSAGES',
    inputSchema: z.object({ query: z.string().trim().min(1).max(200), count: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).max(50).optional(), sort: z.enum(['score', 'timestamp']).optional(), sort_dir: z.enum(['asc', 'desc']).optional() }),
  },
  read_slack_thread: {
    title: 'Read a Slack message thread',
    description: 'Read a Slack conversation thread using its channel ID and the parent message timestamp.',
    toolkit: 'slack',
    slug: 'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
    inputSchema: z.object({ channel: z.string().trim().min(1).max(255), ts: z.string().trim().min(1).max(64), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(500).optional() }),
  },
  // Read by the first briefing (lib/suggestions/sources.ts); not offered to agents.
  fetch_recent_gmail: {
    title: 'Fetch recent Gmail messages',
    description: 'List recent Gmail messages matching a Gmail search query.',
    toolkit: 'gmail',
    slug: 'GMAIL_FETCH_EMAILS',
    inputSchema: z.object({ query: z.string().trim().min(1).max(200), max_results: z.number().int().min(1).max(50).optional() }),
  },
} as const

export type ComposioActionName = keyof typeof COMPOSIO_ACTIONS
export type ComposioActionResult = { data: Record<string, unknown> } | { error: string; logId?: string }
export type ComposioActionClient = Pick<Composio, 'connectedAccounts' | 'tools'>

export async function executeComposioAction(
  userId: string,
  actionName: string,
  input: unknown,
  client: ComposioActionClient | null,
): Promise<ComposioActionResult> {
  if (!Object.hasOwn(COMPOSIO_ACTIONS, actionName)) return { error: 'integrationActionNotAllowed' }
  const action = COMPOSIO_ACTIONS[actionName as ComposioActionName]
  const parsed = action.inputSchema.safeParse(input)
  if (!parsed.success) return { error: 'invalidIntegrationInput' }
  if (!client) return { error: 'composioNotConfigured' }

  try {
    const accounts = await listComposioPages(cursor => client.connectedAccounts.list({
      userIds: [userId], toolkitSlugs: [action.toolkit], statuses: ['ACTIVE'], cursor,
    }))
    const active = accounts.filter(account => account.toolkit.slug === action.toolkit && account.status === 'ACTIVE' && !account.isDisabled)
    if (active.length === 0) return { error: 'integrationNotConnected' }
    if (active.length > 1) return { error: 'integrationMultipleAccounts' }

    const schema = await client.tools.getRawComposioToolBySlug(action.slug)
    if (!schema.version || schema.version === 'latest') return { error: 'integrationActionVersionUnavailable' }

    const result = await client.tools.execute(action.slug, {
      userId,
      connectedAccountId: active[0].id,
      version: schema.version,
      arguments: parsed.data as Record<string, unknown>,
    })
    return result.successful
      ? { data: result.data, ...(result.logId ? { logId: result.logId } : {}) }
      : { error: result.error ?? 'integrationActionFailed', ...(result.logId ? { logId: result.logId } : {}) }
  } catch (error) {
    console.error('Composio read action failed', {
      action: action.slug,
      error: error instanceof Error ? error.name : 'unknown',
    })
    return { error: 'integrationActionFailed' }
  }
}

export function createComposioAITools(execute: (action: ComposioActionName, input: unknown) => Promise<unknown>) {
  return {
    search_notion_pages: tool({ ...COMPOSIO_ACTIONS.search_notion_pages, execute: input => execute('search_notion_pages', input) }),
    read_notion_page_blocks: tool({ ...COMPOSIO_ACTIONS.read_notion_page_blocks, execute: input => execute('read_notion_page_blocks', input) }),
    search_slack_messages: tool({ ...COMPOSIO_ACTIONS.search_slack_messages, execute: input => execute('search_slack_messages', input) }),
    read_slack_thread: tool({ ...COMPOSIO_ACTIONS.read_slack_thread, execute: input => execute('read_slack_thread', input) }),
  }
}
