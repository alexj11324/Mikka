import type { ComposioActionClient } from '../composio-actions'
import { listComposioPages } from '../composio-pagination'
import { OperationError } from './ledger'
import type { WriteActionName, WriteProvider } from './write-contract'
import { channelSnapshot, calendarSnapshot, snapshotDigest } from './write-target'
import { createHash } from 'node:crypto'

const definitions = {
  append_notion_paragraph: { toolkit: 'notion', write: 'NOTION_APPEND_BLOCK_CHILDREN', read: 'NOTION_RETRIEVE_PAGE' },
  send_slack_message: { toolkit: 'slack', write: 'SLACK_SEND_MESSAGE', read: 'SLACK_RETRIEVE_CONVERSATION_INFORMATION' },
  cancel_calendar_event: { toolkit: 'googlecalendar', write: 'GOOGLECALENDAR_DELETE_EVENT', read: 'GOOGLECALENDAR_EVENTS_GET' },
} as const
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
export function writeArguments(action: WriteActionName, p: Record<string, unknown>) {
  if (action === 'append_notion_paragraph') return { block_id: p.page_id, children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.text } }] } }] }
  if (action === 'send_slack_message') return { channel: p.channel, text: String(p.text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false }
  return { calendar_id: 'primary', event_id: p.event_id, send_updates: p.send_updates }
}
/** Native tool schemas/permissions must still be accepted against a specifically
 * authorized test connection before enabling this adapter in product tooling. */
export type ConditionalCalendarDelete = (input: { ownerId: string; accountId: string; eventId: string; ifMatch: string; sendUpdates: 'none' | 'all'; signal: AbortSignal; beforeSend: () => Promise<void> }) => Promise<{ status: number }>
export type SlackReadContract = { version: string; metadataDigest: string }
export function composioWriteProvider(client: ComposioActionClient | null, action: WriteActionName, conditionalDelete?: ConditionalCalendarDelete, slackReadContract?: SlackReadContract): WriteProvider {
  const d = definitions[action]
  async function account(owner: string) {
    if (!client) throw new OperationError('composioNotConfigured')
    const rows = await listComposioPages(cursor => client.connectedAccounts.list({ userIds: [owner], toolkitSlugs: [d.toolkit], statuses: ['ACTIVE'], cursor }))
    const active = rows.filter(a => a.toolkit.slug === d.toolkit && a.status === 'ACTIVE' && !a.isDisabled)
    if (active.length !== 1) throw new OperationError('integrationAccountUnavailable')
    return active[0].id
  }
  async function version(slug: string) {
    const tool = await client!.tools.getRawComposioToolBySlug(slug)
    if (!tool.version || tool.version === 'latest') throw new OperationError('integrationActionVersionUnavailable')
    return tool.version
  }
  async function inspect(owner: string, accountId: string, payload: Record<string, unknown>) {
      if (action === 'send_slack_message') {
        // Catalog name alone is not a parameter contract. Default closed until a
        // reviewed, versioned raw metadata fixture is supplied by the host.
        if (!slackReadContract || !slackReadContract.version.trim() || slackReadContract.version === 'latest' || !/^[a-f0-9]{64}$/.test(slackReadContract.metadataDigest)) throw new OperationError('integrationToolContractUnavailable')
        const raw = await client!.tools.getRawComposioToolBySlug(d.read)
        if (raw.version !== slackReadContract.version || snapshotDigest(raw) !== slackReadContract.metadataDigest) throw new OperationError('integrationToolContractUnavailable')
      }
      const args = action === 'append_notion_paragraph' ? { page_id: payload.page_id } : action === 'send_slack_message' ? { channel: payload.channel } : { calendar_id: 'primary', event_id: payload.event_id }
      const read = await client!.tools.execute(d.read, { userId: owner, connectedAccountId: accountId, version: action === 'send_slack_message' ? slackReadContract!.version : await version(d.read), arguments: args })
      if (!read.successful) throw new OperationError('integrationTargetUnavailable')
      const outer = record(read.data), data = record(outer.response_data ?? outer), channel = record(data.channel)
      const returned = action === 'send_slack_message' ? channel.id : data.id
      const target = action === 'append_notion_paragraph' ? payload.page_id : action === 'send_slack_message' ? payload.channel : payload.event_id
      if (typeof returned !== 'string' || (action === 'append_notion_paragraph' ? returned.replaceAll('-', '') !== String(target).replaceAll('-', '') : returned !== target)) throw new OperationError('integrationTargetUnavailable')
      if (data.archived === true || data.in_trash === true || data.status === 'cancelled') throw new OperationError('integrationTargetUnavailable')
      if (action === 'send_slack_message') return channelSnapshot(channel, target)
      if (action === 'cancel_calendar_event') return calendarSnapshot(data, target, payload.send_updates)
      return { targetId: target }
  }
  return {
    name: `composio-${d.toolkit}`,
    async prepare(owner, payload) {
      const accountId = await account(owner), pinned = await version(d.write)
      return { accountId, version: pinned, context: await inspect(owner, accountId, payload) }
    },
    async execute(p) {
      p.signal.throwIfAborted()
      if (await account(p.ownerId) !== p.accountId) throw new OperationError('integrationAccountUnavailable')
      const recheck = async () => {
        p.signal.throwIfAborted(); await p.beforeSend(); p.signal.throwIfAborted()
        if (action !== 'append_notion_paragraph') {
          const current = await inspect(p.ownerId, p.accountId, p.payload)
          if (snapshotDigest(current) !== snapshotDigest(p.approvalContext)) throw new OperationError('operationTargetChanged')
        }
        p.signal.throwIfAborted(); await p.beforeSend(); p.signal.throwIfAborted()
      }
      await recheck()
      if (action === 'cancel_calendar_event') {
        // Do not guess an if_match tool argument: only an explicitly supplied
        // transport that atomically honors Google's If-Match can cancel.
        if (!conditionalDelete) throw new OperationError('integrationConditionalWriteUnavailable')
        const result = await conditionalDelete({ ownerId: p.ownerId, accountId: p.accountId, eventId: String(p.payload.event_id), ifMatch: String(p.approvalContext!.etag), sendUpdates: p.payload.send_updates as 'none' | 'all', signal: p.signal, beforeSend: recheck })
        if (result.status !== 204) throw new OperationError('operationUncertain')
        return { providerObjectId: String(p.payload.event_id), evidenceDigest: createHash('sha256').update(JSON.stringify([p.accountId, action, p.approvalContext])).digest('hex') }
      }
      const result = await client!.tools.execute(d.write, { userId: p.ownerId, connectedAccountId: p.accountId, version: p.version, arguments: writeArguments(action, p.payload) }, { signal: p.signal, beforeExecute: async ({ params }) => { await recheck(); return params } })
      if (!result.successful) throw new OperationError('operationUncertain')
      const outer = record(result.data), data = record(outer.response_data ?? outer)
      if (data.ok === false || data.success === false) throw new OperationError('operationUncertain')
      let id: unknown
      if (action === 'send_slack_message') { if (data.channel !== p.payload.channel) throw new OperationError('operationUncertain'); id = data.ts }
      else { const results = data.results; if (Array.isArray(results) && results.length === 1) id = record(results[0]).id }
      if (typeof id !== 'string' || !id || id.length > 1024) throw new OperationError('operationUncertain')
      return { providerObjectId: id, evidenceDigest: createHash('sha256').update(JSON.stringify([p.accountId, action, p.payload, id])).digest('hex') }
    },
    async lookup() { return null },
  }
}
