import type { ComposioActionName, ComposioActionResult } from '@/lib/composio-actions'
import type { ExternalNotification } from '@/lib/suggestions/notification'

const SOURCE_MAX = 6000

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * More of the source than the notification carried, read through the
 * person's own connection: the whole mail, or the whole Slack thread. Null
 * when the source has nothing more or the read fails.
 */
export async function fullSource(notification: ExternalNotification, runComposioAction: (userId: string, action: ComposioActionName, input: unknown, accountId?: string) => Promise<ComposioActionResult>): Promise<string | null> {
  try {
    if ((notification.source === 'gmail' || notification.source === 'slack') && !notification.connectedAccountId) return null
    if (notification.source === 'gmail') {
      const result = await runComposioAction(notification.userId, 'read_gmail_message', { message_id: notification.externalId }, notification.connectedAccountId)
      if ('error' in result) return null
      const data = result.data
      const body = text(data.messageText) || text(data.message_text) || text((data.preview as Record<string, unknown> | undefined)?.body)
      return body ? `from: ${text(data.sender) || notification.actor || ''}\nsubject: ${text(data.subject) || notification.title}\n${body}`.slice(0, SOURCE_MAX) : null
    }
    if (notification.source === 'slack') {
      const [, channel, ts] = notification.matterKey.split(':')
      if (!channel || !ts) return null
      const result = await runComposioAction(notification.userId, 'read_slack_thread', { channel, ts, limit: 30 }, notification.connectedAccountId)
      if ('error' in result) return null
      const messages = Array.isArray(result.data.messages) ? result.data.messages as Record<string, unknown>[] : []
      const thread = messages.map(message => `${text(message.user) || text(message.username) || 'someone'}: ${text(message.text)}`).join('\n')
      return thread ? thread.slice(0, SOURCE_MAX) : null
    }
  } catch (error) {
    console.error('Attention reread failed', error instanceof Error ? error.message : error)
  }
  return null
}
