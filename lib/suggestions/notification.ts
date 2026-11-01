import type { SuggestionAction, SuggestionSource } from '@/lib/db/schema'

// Every connected app's event becomes one ExternalNotification for one person
// before the rules and the decision model look at it. The title is the
// source's own text (email subject, Slack message, PR title), never a rewrite.

export interface ExternalNotification {
  userId: string
  connectedAccountId?: string
  source: SuggestionSource
  /** Stable per source, so a repeat delivery is recognised. */
  externalId: string
  /** The matter it belongs to: the mail thread, Slack thread, page, issue or pull request. Repeated notices share it. */
  matterKey: string
  action: SuggestionAction
  title: string
  url: string | null
  actor: string | null
  occurredAt: Date
  /** Assigned to the person, or their review is requested. */
  required: boolean
  /** Addressed to the person: a DM, a reply on their PR, mail Gmail marks important. */
  direct: boolean
  /** The person did it themselves. */
  fromSelf: boolean
  /** A bot, a no-reply sender, or a promotions/updates mail. */
  automated: boolean
  /** What the decision model reads besides the title. */
  excerpt: string
}

type Json = Record<string, unknown>

const TITLE_MAX = 200
const EXCERPT_MAX = 2000

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function str(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function oneLine(text: string, max = TITLE_MAX) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * A comment's words as a person reads them: Markdown and HTML markup, link
 * reference definitions (a bot's hidden metadata such as `[vc]: #…`) and
 * comments taken out, one line. Empty when nothing readable is left.
 */
export function readableText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, ' ')
    .replace(/^ {0,3}(```|~~~)[^\n]*$/gm, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^ {0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function date(...values: unknown[]): Date {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    const numeric = typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : NaN
    // Slack sends seconds, Gmail milliseconds.
    const parsed = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(String(value))
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

function base(userId: string, source: SuggestionSource, fields: Partial<ExternalNotification> & Pick<ExternalNotification, 'externalId' | 'action' | 'title'>): ExternalNotification {
  return { userId, source, matterKey: `${source}:${fields.externalId}`, url: null, actor: null, occurredAt: new Date(), required: false, direct: false, fromSelf: false, automated: false, excerpt: '', ...fields, title: oneLine(fields.title), ...(fields.excerpt ? { excerpt: fields.excerpt.slice(0, EXCERPT_MAX) } : {}) }
}

// --- Gmail (Composio trigger GMAIL_NEW_GMAIL_MESSAGE, or GMAIL_FETCH_EMAILS) --

const AUTOMATED_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM']
const NO_REPLY = /(^|[<\s"])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|newsletter)@/i

function labels(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : []
}

/** One Gmail message, or null when it has no id. Field names differ between Composio versions, so both spellings are read. */
export function gmailNotification(userId: string, message: Json): ExternalNotification | null {
  const id = str(message.messageId, message.message_id, message.id)
  if (!id) return null
  const threadId = str(message.threadId, message.thread_id) || id
  const preview = record(message.preview)
  const labelIds = labels(message.labelIds ?? message.label_ids)
  const sender = str(message.sender, message.from)
  const subject = str(message.subject, preview.subject)
  return base(userId, 'gmail', {
    externalId: id,
    matterKey: `gmail:${threadId}`,
    action: 'reply',
    title: subject || sender || '(no subject)',
    url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`,
    actor: sender || null,
    occurredAt: date(message.messageTimestamp, message.message_timestamp, message.internalDate),
    direct: labelIds.includes('IMPORTANT') || labelIds.includes('STARRED'),
    fromSelf: labelIds.includes('SENT') && !labelIds.includes('INBOX'),
    automated: labelIds.some(label => AUTOMATED_LABELS.includes(label)) || NO_REPLY.test(sender),
    excerpt: `from: ${sender}\nsubject: ${subject}\n${str(message.messageText, message.message_text, preview.body, message.snippet)}`,
  })
}

// --- Slack (Composio trigger SLACK_RECEIVE_MESSAGE) --------------------------

export function slackNotification(userId: string, event: Json): ExternalNotification | null {
  const channel = str(event.channel, event.channel_id)
  const ts = str(event.ts, event.event_ts)
  const text = str(event.text)
  if (!channel || !ts || !text) return null
  const channelType = str(event.channel_type)
  return base(userId, 'slack', {
    externalId: `${channel}:${ts}`,
    matterKey: `slack:${channel}:${str(event.thread_ts) || ts}`,
    action: 'reply',
    title: text,
    actor: str(event.user, event.user_id, event.username) || null,
    occurredAt: date(ts),
    direct: channelType === 'im' || channel.startsWith('D'),
    automated: Boolean(event.bot_id) || str(event.subtype) === 'bot_message',
    excerpt: `channel: ${channel}${channelType ? ` (${channelType})` : ''}\n${text}`,
  })
}

// --- Notion (any Composio Notion trigger) ------------------------------------

export function notionNotification(userId: string, event: Json): ExternalNotification | null {
  const page = record(event.page ?? event.data)
  const id = str(event.page_id, event.id, page.id)
  const title = str(event.title, event.page_title, page.title)
  if (!id || !title) return null
  const editedAt = str(event.last_edited_time, page.last_edited_time)
  return base(userId, 'notion', {
    externalId: `${id}:${editedAt}`,
    matterKey: `notion:${id}`,
    action: 'read',
    title,
    url: str(event.url, page.url) || null,
    actor: str(record(event.last_edited_by).name, event.author) || null,
    occurredAt: date(editedAt),
    excerpt: `title: ${title}\n${str(event.content, event.text, event.comment)}`,
  })
}

/** The plain text of a Notion page's title property. */
function notionTitle(page: Json): string {
  for (const property of Object.values(record(page.properties))) {
    const value = record(property)
    if (value.type !== 'title' || !Array.isArray(value.title)) continue
    return value.title.map(part => { const text = record(part).plain_text; return typeof text === 'string' ? text : '' }).join('')
  }
  return ''
}

/** One page from Notion's search (NOTION_SEARCH_NOTION_PAGE), read like the trigger event. */
export function notionSearchNotification(userId: string, page: Json): ExternalNotification | null {
  if (page.object !== 'page' || page.archived === true || page.in_trash === true) return null
  return notionNotification(userId, {
    id: page.id, title: notionTitle(page), url: page.url,
    last_edited_time: page.last_edited_time, last_edited_by: page.last_edited_by,
  })
}

/** A verified Composio trigger event, or null for a toolkit or shape we do not read. */
export function composioNotification(event: { userId: string; toolkitSlug: string; payload?: Json; metadata?: { connectedAccount?: { id?: string } } }): ExternalNotification | null {
  const payload = record(event.payload)
  let notification: ExternalNotification | null
  switch (event.toolkitSlug.toLowerCase()) {
    case 'gmail': notification = gmailNotification(event.userId, payload); break
    case 'slack': notification = slackNotification(event.userId, payload); break
    case 'notion': notification = notionNotification(event.userId, payload); break
    default: return null
  }
  if (!notification) return null
  return { ...notification, connectedAccountId: event.metadata?.connectedAccount?.id || undefined }

}

// --- Linear (organisation webhook) -------------------------------------------

/** The person's Linear identity, from linear_connections. */
export interface LinearRecipient { userId: string; linearUserId: string }

/** An issue was assigned to the person by someone else. */
export function linearIssueNotification(recipient: LinearRecipient, payload: Json): ExternalNotification | null {
  const data = record(payload.data)
  const updatedFrom = record(payload.updatedFrom)
  const actor = record(payload.actor)
  const assigned = payload.action === 'create' || Object.hasOwn(updatedFrom, 'assigneeId')
  if (payload.type !== 'Issue' || !assigned || data.assigneeId !== recipient.linearUserId) return null
  const id = str(data.id)
  if (!id) return null
  return base(recipient.userId, 'linear', {
    externalId: `issue:${id}:assigned:${str(payload.webhookTimestamp, data.updatedAt)}`,
    matterKey: `linear:${id}`,
    action: 'handle',
    title: str(data.title) || str(data.identifier),
    url: str(payload.url, data.url) || null,
    actor: str(actor.name) || null,
    occurredAt: date(data.updatedAt, payload.createdAt),
    required: true,
    fromSelf: str(actor.id) === recipient.linearUserId,
    automated: str(actor.type) !== '' && str(actor.type) !== 'user',
    excerpt: `${str(data.identifier)} ${str(data.title)}\n${str(data.description)}`,
  })
}

/** Someone commented on an issue the person owns in Mikka. */
export function linearCommentNotification(recipient: LinearRecipient, payload: Json): ExternalNotification | null {
  const data = record(payload.data)
  if (payload.type !== 'Comment' || payload.action !== 'create') return null
  const id = str(data.id)
  const body = readableText(str(data.body))
  if (!id || !body) return null
  const issue = record(data.issue)
  const actor = record(payload.actor)
  return base(recipient.userId, 'linear', {
    externalId: `comment:${id}`,
    matterKey: `linear:${str(data.issueId, issue.id) || id}`,
    action: 'reply',
    title: body,
    url: str(payload.url, data.url) || null,
    actor: str(actor.name, record(data.user).name) || null,
    occurredAt: date(data.createdAt, payload.createdAt),
    direct: true,
    fromSelf: str(data.userId, actor.id) === recipient.linearUserId,
    automated: Boolean(data.botActor) || (str(actor.type) !== '' && str(actor.type) !== 'user'),
    excerpt: `issue: ${str(issue.title)}\ncomment: ${body}`,
  })
}

// --- GitHub (repository or app webhook) --------------------------------------

/** One person's GitHub identity: the numeric id from their GitHub sign-in. */
export interface GitHubRecipient { userId: string; githubId: string }

/** The GitHub ids an event could be for; the route maps them to people. */
export function githubCandidateIds(event: string, payload: Json): string[] {
  const ids = new Set<string>()
  const add = (value: unknown) => { const id = str(record(value).id); if (id) ids.add(id) }
  if (event === 'pull_request' && payload.action === 'review_requested') add(payload.requested_reviewer)
  if ((event === 'pull_request' || event === 'issues') && payload.action === 'assigned') add(payload.assignee)
  if (event === 'issue_comment' && payload.action === 'created') add(record(payload.issue).user)
  if ((event === 'pull_request_review' && payload.action === 'submitted') || (event === 'pull_request_review_comment' && payload.action === 'created')) add(record(payload.pull_request).user)
  return [...ids]
}

/** A GitHub event for one person, or null when it is not about them. */
export function githubNotification(recipient: GitHubRecipient, event: string, payload: Json): ExternalNotification | null {
  const sender = record(payload.sender)
  const repo = str(record(payload.repository).full_name)
  // A GitHub App posts as a Bot user named `<app>[bot]` (Vercel, GitGuardian, CI).
  const bot = str(sender.type) === 'Bot' || str(sender.login).endsWith('[bot]')
  const common = {
    actor: str(sender.login) || null,
    fromSelf: str(sender.id) === recipient.githubId,
    automated: bot,
  }
  const pr = record(payload.pull_request)
  const issue = record(payload.issue)
  const action = str(payload.action)
  const isMe = (value: unknown) => str(record(value).id) === recipient.githubId
  const matter = (item: Json) => `github:${repo}#${str(item.number)}`

  if (event === 'pull_request' && action === 'review_requested' && isMe(payload.requested_reviewer)) {
    return base(recipient.userId, 'github', { ...common, matterKey: matter(pr), externalId: `${repo}#${str(pr.number)}:review_requested:${str(pr.updated_at)}`, action: 'review', title: str(pr.title), url: str(pr.html_url) || null, occurredAt: date(pr.updated_at), required: true, excerpt: `${repo}#${str(pr.number)} ${str(pr.title)}\n${str(pr.body)}` })
  }
  if ((event === 'pull_request' || event === 'issues') && action === 'assigned' && isMe(payload.assignee)) {
    const item = event === 'pull_request' ? pr : issue
    return base(recipient.userId, 'github', { ...common, matterKey: matter(item), externalId: `${repo}#${str(item.number)}:assigned:${str(item.updated_at)}`, action: 'handle', title: str(item.title), url: str(item.html_url) || null, occurredAt: date(item.updated_at), required: true, excerpt: `${repo}#${str(item.number)} ${str(item.title)}\n${str(item.body)}` })
  }
  // A bot's comment or review is nobody to reply to.
  if (bot && (event === 'issue_comment' || event === 'pull_request_review_comment' || event === 'pull_request_review')) return null
  if (event === 'issue_comment' && action === 'created' && isMe(issue.user)) {
    const comment = record(payload.comment)
    const text = readableText(str(comment.body))
    if (!text) return null
    return base(recipient.userId, 'github', { ...common, matterKey: matter(issue), externalId: `comment:${str(comment.id)}`, action: 'reply', title: text, url: str(comment.html_url) || null, occurredAt: date(comment.created_at), direct: true, excerpt: `on ${repo}#${str(issue.number)} ${str(issue.title)}\n${str(comment.body)}` })
  }
  if (event === 'pull_request_review_comment' && action === 'created' && isMe(pr.user)) {
    const comment = record(payload.comment)
    const text = readableText(str(comment.body))
    if (!text) return null
    return base(recipient.userId, 'github', { ...common, matterKey: matter(pr), externalId: `review_comment:${str(comment.id)}`, action: 'reply', title: text, url: str(comment.html_url) || null, occurredAt: date(comment.created_at), direct: true, excerpt: `on ${repo}#${str(pr.number)} ${str(pr.title)}\n${str(comment.body)}` })
  }
  if (event === 'pull_request_review' && action === 'submitted' && isMe(pr.user)) {
    const review = record(payload.review)
    const state = str(review.state)
    return base(recipient.userId, 'github', { ...common, matterKey: matter(pr), externalId: `review:${str(review.id)}`, action: 'reply', title: str(pr.title), url: str(review.html_url, pr.html_url) || null, occurredAt: date(review.submitted_at), required: state === 'changes_requested', direct: true, excerpt: `review ${state} on ${repo}#${str(pr.number)} ${str(pr.title)}\n${str(review.body)}` })
  }
  return null
}
