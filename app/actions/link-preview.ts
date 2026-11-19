'use server'

import { requireUser } from '@/lib/issue-access'
import { linkPreview, type LinkPreview } from '@/lib/link-preview'
import { LINK_PREVIEW_MAX_URL_LENGTH, LINK_PREVIEWS_PER_REQUEST } from '@/lib/link-preview-batch'

/** The preview for a link in the person's Coordinator chat. Signed-in people only, so this is no open proxy. */
export async function getLinkPreview(url: string): Promise<LinkPreview | null> {
  await requireUser()
  if (typeof url !== 'string' || url.length > LINK_PREVIEW_MAX_URL_LENGTH) return null
  return linkPreview(url)
}

/** Previews for several links at once: one `requireUser` for the batch. The
 * limit lives in lib/link-preview-batch.ts, because a non-function export of
 * this module is not emitted into the renderer build. */
export async function getLinkPreviews(urls: readonly string[]): Promise<Record<string, LinkPreview | null>> {
  await requireUser()
  const unique = [...new Set(urls)].filter(url => typeof url === 'string' && url.length <= LINK_PREVIEW_MAX_URL_LENGTH).slice(0, LINK_PREVIEWS_PER_REQUEST)
  const results = await Promise.all(unique.map(url => linkPreview(url).catch(() => null)))
  return Object.fromEntries(unique.map((url, index) => [url, results[index]]))
}
