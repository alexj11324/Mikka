import { useEffect, useState } from 'react'
import type { ImageURISource } from 'react-native'
import { CHAT_IMAGE_EXTENSIONS, fileExtension, type ChatFile } from '@mikka/protocol/chat-attachments'
import { api, authHeaders } from '@/lib/api'
import { API_URL } from '@/lib/config'

/** A chat file the gallery draws as a picture rather than a file chip. */
export const isImageFile = (file: Pick<ChatFile, 'name'>) => CHAT_IMAGE_EXTENSIONS.has(fileExtension(file.name))

/** A storage link is good for a while; the gallery asks again after this, so an old chat never shows broken pictures. */
const LINK_LIFETIME_MS = 10 * 60_000

const resolved = new Map<string, { source: ImageURISource; at: number }>()
const resolving = new Map<string, Promise<ImageURISource | null>>()

/**
 * Where a picture sent as a chat file loads from: the storage link the server grants (no headers, so none leak to
 * storage), or the server itself, signed in, when the file lives in the database. Null when it cannot be read.
 */
export function imageFileSource(id: string): Promise<ImageURISource | null> {
  const kept = resolved.get(id)
  if (kept && Date.now() - kept.at < LINK_LIFETIME_MS) return Promise.resolve(kept.source)
  let request = resolving.get(id)
  if (!request) {
    request = (async () => {
      const grant = await api<{ downloadUrl: string }>(`/api/chat/attachments/${id}?download-url`)
      const url = new URL(grant.downloadUrl)
      const sameOrigin = url.origin === new URL(API_URL).origin
      if (!sameOrigin && url.protocol !== 'https:') return null
      const source: ImageURISource = sameOrigin ? { uri: grant.downloadUrl, headers: await authHeaders() } : { uri: grant.downloadUrl }
      resolved.set(id, { source, at: Date.now() })
      return source
    })().catch(() => null).finally(() => { resolving.delete(id) })
    resolving.set(id, request)
  }
  return request
}

/** The pictures among a message's files, as sources; an empty `uri` while one is still being looked up. */
export function useImageFiles(files: Pick<ChatFile, 'id' | 'name'>[]): ImageURISource[] {
  const ids = files.filter(isImageFile).map(file => file.id)
  const key = ids.join(',')
  const [sources, setSources] = useState<Record<string, ImageURISource | null>>({})
  useEffect(() => {
    let live = true
    for (const id of key ? key.split(',') : []) void imageFileSource(id).then(source => { if (live) setSources(current => ({ ...current, [id]: source })) })
    return () => { live = false }
  }, [key])
  return ids.map(id => sources[id] ?? { uri: '' })
}
