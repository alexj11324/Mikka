'use server'

import { requireUser } from '@/lib/issue-access'
import { linkPreview, type LinkPreview } from '@/lib/link-preview'

/** The preview for a link in the person's Coordinator chat. Signed-in people only, so this is no open proxy. */
export async function getLinkPreview(url: string): Promise<LinkPreview | null> {
  await requireUser()
  if (typeof url !== 'string' || url.length > 2000) return null
  return linkPreview(url)
}
