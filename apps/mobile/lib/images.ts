import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { isImageQuery } from '@/lib/openui'

/** What the server's image lookup returns (AgentImageResult in lib/agent-images.ts). */
export interface FoundImage { src: string; width: number; height: number; title: string; source: string; author: string; license: string }

const found = new Map<string, FoundImage | null>()
const looking = new Map<string, Promise<FoundImage | null>>()

/**
 * The picture for an image card's search words, from the server's Wikimedia
 * Commons lookup (app/api/agent/images), as the web's cards find theirs. Null
 * when there is none, the words are not a valid query, or the lookup failed.
 * Kept for the app's life, so scrolling back never looks again.
 */
export function findImage(query: string): Promise<FoundImage | null> {
  const key = query.trim()
  if (found.has(key)) return Promise.resolve(found.get(key) ?? null)
  if (!isImageQuery(key)) return Promise.resolve(null)
  let request = looking.get(key)
  if (!request) {
    request = api<{ image: FoundImage | null }>(`/api/agent/images?q=${encodeURIComponent(key)}`)
      .then(data => data?.image?.src ? data.image : null, () => null)
      .then(image => { found.set(key, image); looking.delete(key); return image })
    looking.set(key, request)
  }
  return request
}

/** The card's picture: undefined while looking, null when there is none. */
export function useImage(query: string): FoundImage | null | undefined {
  const [image, setImage] = useState(() => found.get(query.trim()))
  useEffect(() => {
    let mounted = true
    void findImage(query).then(result => { if (mounted) setImage(result) })
    return () => { mounted = false }
  }, [query])
  return image
}
