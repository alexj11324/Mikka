import { splitCitations } from '@/lib/coordinator/citations'

export type UserMessagePart = { type: 'text'; text: string } | { type: 'link'; url: string; label: string }

const MAX_PATH = 24

/** `vercel.com`, `github.com/vercel/next.js`, `docs.example.com/guides/…`: the host without `www.` and a path short enough for a chip. */
export function linkChipLabel(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.replace(/^www\./, '')
  const path = parsed.pathname.replace(/\/+$/, '')
  if (!path) return host
  if (path.length <= MAX_PATH) return host + path
  const first = path.split('/').filter(Boolean)[0] ?? ''
  return first.length <= MAX_PATH ? `${host}/${first}/…` : `${host}/…`
}

/** A sent message split into its text and its web links, for display only; the stored text is unchanged. */
export function userMessageParts(text: string): UserMessagePart[] {
  const parts: UserMessagePart[] = []
  const push = (value: string) => {
    const previous = parts.at(-1)
    if (previous?.type === 'text') previous.text += value
    else if (value) parts.push({ type: 'text', text: value })
  }
  for (const part of splitCitations(text)) {
    if (part.type === 'text') push(part.text)
    else if (part.type === 'link') {
      const label = part.label ?? linkChipLabel(part.url)
      if (label) parts.push({ type: 'link', url: part.url, label })
      else push(part.raw)
    } else push(part.raw)
  }
  return parts
}
