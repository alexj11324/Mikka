'use server'

import { requireUser } from '@/lib/issue-access'
import { linkPreview, type LinkPreview } from '@/lib/link-preview'

/** The preview for a link in the person's Coordinator chat. Signed-in people only, so this is no open proxy. */
export async function getLinkPreview(url: string): Promise<LinkPreview | null> {
  await requireUser()
  if (typeof url !== 'string' || url.length > 2000) return null
  return linkPreview(url)
}

/** At most this many links per round trip, so a long thread cannot become one
 * slow action (the batching shape lib/message-reactions.ts uses). */
export const LINK_PREVIEWS_PER_REQUEST = 50

/** Previews for several links at once: one `requireUser` for the batch. */
export async function getLinkPreviews(urls: readonly string[]): Promise<Record<string, LinkPreview | null>> {
  await requireUser()
  const unique = [...new Set(urls)].filter(url => typeof url === 'string' && url.length <= 2000).slice(0, LINK_PREVIEWS_PER_REQUEST)
  const results = await Promise.all(unique.map(url => linkPreview(url).catch(() => null)))
  return Object.fromEntries(unique.map((url, index) => [url, results[index]]))
}
