import type { PoolClient } from 'pg'
import englishMessages from '@/messages/en.json'
import chineseMessages from '@/messages/zh-CN.json'
import { actionLocale, type ActionLocale } from '@/lib/suggestions/action-title'

export type GroupLocale = ActionLocale

export function groupCopy(locale: GroupLocale) {
  return locale === 'en' ? englishMessages.GroupTask : chineseMessages.GroupTask
}

/** Use the same saved person locale as personLocale and mobile pushes. A
 * worker has no browser cookie; the initiating user's setting is authoritative. */
export async function readGroupLocale(client: Pick<PoolClient, 'query'>, userId: string): Promise<GroupLocale> {
  const { rows: [row] } = await client.query<{ locale: string | null }>('SELECT locale FROM attention_settings WHERE "userId"=$1', [userId])
  return actionLocale(row?.locale)
}
