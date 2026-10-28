import type { Composio } from '@composio/core'
import { tool } from 'ai'
import { z } from 'zod'

import { pickDefaultAccountId } from '@/lib/composio-accounts'
import { listComposioPages } from '@/lib/composio-pagination'

const email = z.email().max(320)
// ISO 8601 with an optional offset; Google reads an offset-less time in `timezone`.
const dateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/)
const rfc3339 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/)
const timezone = z.string().trim().min(1).max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/)
const eventFields = {
  summary: z.string().trim().min(1).max(300),
  description: z.string().max(8000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(email).max(50).optional(),
  timezone: timezone.optional(),
  /** Whether Google emails the attendees about it. */
  notify_attendees: z.boolean().optional(),
}

function sendUpdates(input: { attendees?: string[]; notify_attendees?: boolean }) {
  return input.notify_attendees === false || !input.attendees?.length ? 'none' : 'all'
}

function defined(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

export const COMPOSIO_ACTIONS = {
  search_notion_pages: {
    title: 'Search Notion pages',
    description: 'Search the connected Notion workspace for pages and databases by title.',
    toolkit: 'notion',
    slug: 'NOTION_SEARCH_NOTION_PAGE',
    inputSchema: z.object({ query: z.string().trim().min(1).max(200), page_size: z.number().int().min(1).max(100).optional(), start_cursor: z.string().max(500).optional() }),
  },
  // Read by the hourly suggestions backfill (lib/suggestions/reconcile.ts); not offered to agents.
  list_recent_notion_pages: {
    title: 'List recently edited Notion pages',
    description: 'List the pages in the connected Notion workspace, most recently edited first.',
    toolkit: 'notion',
    slug: 'NOTION_SEARCH_NOTION_PAGE',
    inputSchema: z.object({ page_size: z.number().int().min(1).max(100).optional() }),
    toArguments: (input: { page_size?: number }) => ({
      query: '', page_size: input.page_size ?? 25, filter_property: 'object', filter_value: 'page', timestamp: 'last_edited_time', direction: 'descending',
    }),
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
  // Read by the first briefing (lib/suggestions/sources.ts) and the Coordinator.
  fetch_recent_gmail: {
    title: 'Fetch recent Gmail messages',
    description: 'List recent Gmail messages matching a Gmail search query.',
    toolkit: 'gmail',
    slug: 'GMAIL_FETCH_EMAILS',
    inputSchema: z.object({ query: z.string().trim().min(1).max(200), max_results: z.number().int().min(1).max(50).optional() }),
  },
  // Read by the attention judgment when a mail excerpt cannot tell (lib/attention/score.ts) and by the Coordinator.
  read_gmail_message: {
    title: 'Read a Gmail message',
    description: 'Read one Gmail message in full by its message id.',
    toolkit: 'gmail',
    slug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    inputSchema: z.object({ message_id: z.string().trim().min(1).max(255) }),
    toArguments: (input: { message_id: string }) => ({ message_id: input.message_id, format: 'full', user_id: 'me' }),
  },
  list_calendar_events: {
    title: 'List Google Calendar events',
    description: 'List events on the person\'s primary Google Calendar that overlap a time window, in start order. Returns each event\'s id, which update_calendar_event needs.',
    toolkit: 'googlecalendar',
    slug: 'GOOGLECALENDAR_EVENTS_LIST',
    inputSchema: z.object({
      time_min: rfc3339.describe('Start of the window, RFC 3339 with an offset, e.g. 2026-10-27T00:00:00-07:00.'),
      time_max: rfc3339.describe('End of the window, RFC 3339 with an offset.'),
      query: z.string().trim().min(1).max(200).optional(),
      max_results: z.number().int().min(1).max(100).optional(),
    }),
    toArguments: (input: { time_min: string; time_max: string; query?: string; max_results?: number }) => defined({
      timeMin: input.time_min, timeMax: input.time_max, query: input.query, maxResults: input.max_results ?? 50, singleEvents: true, orderBy: 'startTime',
    }),
  },
  get_calendar_event: {
    title: 'Read a Google Calendar event',
    description: 'Read one event on the person\'s primary Google Calendar by id.',
    toolkit: 'googlecalendar',
    slug: 'GOOGLECALENDAR_EVENTS_GET',
    inputSchema: z.object({ event_id: z.string().trim().min(1).max(1024) }),
    toArguments: (input: { event_id: string }) => ({ calendar_id: 'primary', event_id: input.event_id }),
  },
  // The three below change the person's mail or calendar. Agents only propose
  // them (lib/pending-actions.ts); they run after the person approves.
  send_email: {
    title: 'Send an email',
    description: 'Send a new plain-text email from the person\'s Gmail.',
    toolkit: 'gmail',
    slug: 'GMAIL_SEND_EMAIL',
    inputSchema: z.object({
      to: z.array(email).min(1).max(20),
      cc: z.array(email).max(20).optional(),
      bcc: z.array(email).max(20).optional(),
      subject: z.string().trim().min(1).max(300),
      body: z.string().trim().min(1).max(20_000),
    }),
    toArguments: (input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string }) => defined({
      recipient_email: input.to[0], extra_recipients: input.to.slice(1), cc: input.cc, bcc: input.bcc, subject: input.subject, body: input.body, is_html: false,
    }),
  },
  create_calendar_event: {
    title: 'Create a calendar event',
    description: 'Create an event on the person\'s primary Google Calendar.',
    toolkit: 'googlecalendar',
    slug: 'GOOGLECALENDAR_CREATE_EVENT',
    inputSchema: z.object({ ...eventFields, start: dateTime, end: dateTime }),
    toArguments: (input: { summary: string; description?: string; location?: string; attendees?: string[]; timezone?: string; notify_attendees?: boolean; start: string; end: string }) => defined({
      calendar_id: 'primary', summary: input.summary, description: input.description, location: input.location, attendees: input.attendees,
      timezone: input.timezone, start_datetime: input.start, end_datetime: input.end, send_updates: sendUpdates(input), create_meeting_room: false,
    }),
  },
  update_calendar_event: {
    title: 'Change a calendar event',
    description: 'Change fields of an event on the person\'s primary Google Calendar. Fields left out stay as they are; attendees, when given, replace the list.',
    toolkit: 'googlecalendar',
    slug: 'GOOGLECALENDAR_PATCH_EVENT',
    inputSchema: z.object({
      event_id: z.string().trim().min(1).max(1024),
      ...eventFields,
      summary: eventFields.summary.optional(),
      start: dateTime.optional(),
      end: dateTime.optional(),
    }).refine(input => ['summary', 'description', 'location', 'attendees', 'start', 'end'].some(key => input[key as keyof typeof input] !== undefined), { message: 'nothingToChange' }),
    toArguments: (input: { event_id: string; summary?: string; description?: string; location?: string; attendees?: string[]; timezone?: string; notify_attendees?: boolean; start?: string; end?: string }) => defined({
      calendar_id: 'primary', event_id: input.event_id, summary: input.summary, description: input.description, location: input.location,
      attendees: input.attendees, timezone: input.timezone, start_time: input.start, end_time: input.end,
      send_updates: input.notify_attendees === false ? 'none' : 'all',
    }),
  },
} as const

export type ComposioActionName = keyof typeof COMPOSIO_ACTIONS
/** Actions that change the person's mail or calendar; they run only once the person approves. */
export const APPROVAL_ACTIONS = ['send_email', 'create_calendar_event', 'update_calendar_event'] as const
export type ApprovalActionName = (typeof APPROVAL_ACTIONS)[number]

export function isApprovalAction(name: string): name is ApprovalActionName {
  return (APPROVAL_ACTIONS as readonly string[]).includes(name)
}

/** The checked input of an action, or null when it does not fit the action's schema. */
export function parseActionInput(actionName: ComposioActionName, input: unknown): Record<string, unknown> | null {
  const parsed = COMPOSIO_ACTIONS[actionName].inputSchema.safeParse(input)
  return parsed.success ? parsed.data as Record<string, unknown> : null
}

function actionArguments(actionName: ComposioActionName, input: Record<string, unknown>): Record<string, unknown> {
  const action = COMPOSIO_ACTIONS[actionName]
  return 'toArguments' in action ? (action.toArguments as (value: Record<string, unknown>) => Record<string, unknown>)(input) : input
}
export type ComposioActionResult = { data: Record<string, unknown>; accountId: string } | { error: string; logId?: string }

/** Select a usable account once; callers may bind later operations to its id. */
export async function resolveComposioAccount(userId: string, toolkit: string, client: ComposioActionClient, chosenDefault: (toolkit: string) => Promise<string | null>): Promise<string | null> {
  const accounts = await listComposioPages(cursor => client.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [toolkit], statuses: ['ACTIVE'], cursor }))
  const own = accounts.filter(account => account.toolkit.slug === toolkit)
  return pickDefaultAccountId(own, own.length > 1 ? await chosenDefault(toolkit) : null)
}
export type ComposioActionClient = Pick<Composio, 'connectedAccounts' | 'tools'>

export async function executeComposioAction(
  userId: string,
  actionName: string,
  input: unknown,
  client: ComposioActionClient | null,
  /** The account the person chose with 设为默认 for a toolkit, if any. */
  chosenDefault: (toolkit: string) => Promise<string | null> = async () => null,
  boundAccountId?: string,
): Promise<ComposioActionResult> {
  if (!Object.hasOwn(COMPOSIO_ACTIONS, actionName)) return { error: 'integrationActionNotAllowed' }
  const action = COMPOSIO_ACTIONS[actionName as ComposioActionName]
  const parsed = parseActionInput(actionName as ComposioActionName, input)
  if (!parsed) return { error: 'invalidIntegrationInput' }
  if (!client) return { error: 'composioNotConfigured' }

  try {
    const accounts = await listComposioPages(cursor => client.connectedAccounts.list({
      userIds: [userId], toolkitSlugs: [action.toolkit], statuses: ['ACTIVE'], cursor,
    }))
    const own = accounts.filter(account => account.toolkit.slug === action.toolkit)
    // A bound action never falls back to a different account.
    const accountId = boundAccountId
      ? (own.some(account => account.id === boundAccountId && account.status === 'ACTIVE' && !account.isDisabled) ? boundAccountId : null)
      : pickDefaultAccountId(own, own.length > 1 ? await chosenDefault(action.toolkit) : null)
    if (!accountId) return { error: 'integrationNotConnected' }

    const schema = await client.tools.getRawComposioToolBySlug(action.slug)
    if (!schema.version || schema.version === 'latest') return { error: 'integrationActionVersionUnavailable' }

    const result = await client.tools.execute(action.slug, {
      userId,
      connectedAccountId: accountId,
      version: schema.version,
      arguments: actionArguments(actionName as ComposioActionName, parsed),
    })
    return result.successful
      ? { data: result.data, accountId, ...(result.logId ? { logId: result.logId } : {}) }
      : { error: result.error ?? 'integrationActionFailed', ...(result.logId ? { logId: result.logId } : {}) }
  } catch (error) {
    console.error('Composio action failed', {
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

const PROPOSAL_NOTE = ' Nothing happens yet: the person sees exactly this in the chat and approves or declines it, and the outcome arrives later as an [Event]. Write the final text, not a draft to revise.'

/**
 * Gmail and Google Calendar for the person's own Coordinator. Reads run at
 * once; the three that change something only `propose`, and run after the
 * person approves (lib/pending-actions.ts).
 */
export function createGoogleAITools(
  execute: (action: ComposioActionName, input: unknown) => Promise<unknown>,
  propose: (action: ApprovalActionName, input: unknown) => Promise<unknown>,
) {
  return {
    search_gmail: tool({ ...COMPOSIO_ACTIONS.fetch_recent_gmail, title: 'Search Gmail', description: 'Search the person\'s Gmail with a Gmail search query, e.g. "from:ana is:unread newer_than:7d".', execute: input => execute('fetch_recent_gmail', input) }),
    read_gmail_message: tool({ ...COMPOSIO_ACTIONS.read_gmail_message, execute: input => execute('read_gmail_message', input) }),
    list_calendar_events: tool({ ...COMPOSIO_ACTIONS.list_calendar_events, execute: input => execute('list_calendar_events', input) }),
    get_calendar_event: tool({ ...COMPOSIO_ACTIONS.get_calendar_event, execute: input => execute('get_calendar_event', input) }),
    send_email: tool({ ...COMPOSIO_ACTIONS.send_email, description: COMPOSIO_ACTIONS.send_email.description + PROPOSAL_NOTE, execute: input => propose('send_email', input) }),
    create_calendar_event: tool({ ...COMPOSIO_ACTIONS.create_calendar_event, description: COMPOSIO_ACTIONS.create_calendar_event.description + PROPOSAL_NOTE, execute: input => propose('create_calendar_event', input) }),
    update_calendar_event: tool({ ...COMPOSIO_ACTIONS.update_calendar_event, description: COMPOSIO_ACTIONS.update_calendar_event.description + PROPOSAL_NOTE, execute: input => propose('update_calendar_event', input) }),
  }
}
