import type { SuggestionSource, UserFactEvidence } from '@/lib/db/schema'
import type { MemorySourceKind } from './kinds'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { withBasePath } from '@/lib/base-path'

export type MemorySource = { kind: MemorySourceKind; id: string | null; url: string | null }
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const suggestionReference = new RegExp(`^suggestion:(${UUID})$`, 'i')

/** External conversations/documents keep their own namespace; these are not Bot or Artifact ids. */
export const notificationSourceKind = (source: SuggestionSource): 'thread' | 'file' => source === 'notion' ? 'file' : 'thread'
export const suggestionSourceId = (id: string | null) => id?.match(suggestionReference)?.[1].toLowerCase() ?? null
export const memoryTargetUrl = (kind: 'thread' | 'task', id: string) => withBasePath(workspaceLink(kind === 'thread' ? { bot: id } : { issue: id }))

type NoticeSource = { id: string; source: SuggestionSource; externalId: string; matterKey: string | null; url: string | null }

/** The owned stored notice supplies the URL. A provider hostname alone is not proof of its resource. */
export function notificationSourceUrl(notice: NoticeSource): string | null {
  if (!notice.url) return null
  let url: URL
  try { url = new URL(notice.url) } catch { return null }
  if (url.protocol !== 'https:') return null
  if (url.username.length !== 0 || url.password.length !== 0) return null
  if (url.port || url.href !== notice.url) return null
  if (notice.source === 'gmail') {
    const thread = notice.matterKey?.match(/^gmail:([A-Za-z0-9_-]{1,200})$/)?.[1]
    return thread && notice.url === `https://mail.google.com/mail/u/0/#all/${thread}` ? notice.url : null
  }
  if (notice.source === 'github') {
    const matter = notice.matterKey?.match(/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/)
    if (!matter || url.hostname !== 'github.com' || url.search) return null
    const [, repository, number] = matter
    const issuePath = `/${repository}/issues/${number}`, pullPath = `/${repository}/pull/${number}`
    if (url.pathname !== issuePath && url.pathname !== pullPath) return null
    const comment = notice.externalId.match(/^comment:([1-9][0-9]*)$/)
    if (comment) return url.hash === `#issuecomment-${comment[1]}` ? notice.url : null
    const reviewComment = notice.externalId.match(/^review_comment:([1-9][0-9]*)$/)
    if (reviewComment) return url.pathname === pullPath && url.hash === `#discussion_r${reviewComment[1]}` ? notice.url : null
    const review = notice.externalId.match(/^review:([1-9][0-9]*)$/)
    if (review) return url.pathname === pullPath && (!url.hash || url.hash === `#pullrequestreview-${review[1]}`) ? notice.url : null
    return !url.hash && (notice.externalId.startsWith(`${repository}#${number}:assigned:`)
      || url.pathname === pullPath && notice.externalId.startsWith(`${repository}#${number}:review_requested:`)) ? notice.url : null
  }
  if (notice.source === 'notion') {
    const page = notice.matterKey?.match(/^notion:([a-f0-9-]{32,36})$/i)?.[1]
    const id = page?.replaceAll('-', '').toLowerCase()
    const provider = url.hostname === 'notion.so' || url.hostname === 'www.notion.so' || /^[a-z0-9-]+\.notion\.site$/.test(url.hostname)
    const pathId = url.pathname.match(/\/(?:[A-Za-z0-9-]*-)?([a-f0-9]{32})$/i)?.[1].toLowerCase()
    const query = [...url.searchParams.entries()]
    return id && /^[a-f0-9]{32}$/.test(id) && provider && pathId === id && !url.hash
      && notice.externalId.startsWith(`${page}:`) && (query.length === 0 || query.length === 1 && query[0][0] === 'pvs' && /^[0-9]+$/.test(query[0][1]))
      ? notice.url : null
  }
  // Slack ingestion does not store a permalink. Linear's stored issue UUID
  // cannot attest the human identifier in its URL. Their verified notice ID remains useful.
  return null
}

/** The caller already joined the same owner and the current authorized workspace's Bot. */
export function notificationMemorySource(fact: { sourceKind: MemorySourceKind | null; sourceId: string | null; evidence: UserFactEvidence[] }, notice: NoticeSource): MemorySource | null {
  if (suggestionSourceId(fact.sourceId) !== notice.id || fact.sourceKind !== notificationSourceKind(notice.source)
    || !fact.evidence.some(item => item.suggestionId === notice.id && item.source === notice.source && item.externalId === notice.externalId)) return null
  return { kind: fact.sourceKind, id: `suggestion:${notice.id}`, url: notificationSourceUrl(notice) }
}
