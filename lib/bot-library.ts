import { withBasePath } from '@/lib/base-path'

// A bot's 资料库 on the web (R-51, decision 2026-11-01-0050-mobile-chat-settings):
// the person's own documents that the bot's threads handed over, newest first.
// Read from GET /api/mobile/bots/<id> (lib/mobile-threads.ts mobileBot), the same
// list the phone shows; removed with DELETE /api/mobile/artifacts/<id>.

export type LibraryFile = { id: string; title: string; kind: 'markdown' | 'html'; version: number; updatedAt: string }

/** `coordinator` names the Coordinator of the open workspace, as on the phone. */
export function botLibraryUrl(botId: string | null) {
  return withBasePath(`/api/mobile/bots/${encodeURIComponent(botId ?? 'coordinator')}`)
}

export async function fetchBotLibrary(botId: string | null, fetcher: typeof fetch = fetch): Promise<LibraryFile[]> {
  const response = await fetcher(botLibraryUrl(botId), { cache: 'no-store', credentials: 'same-origin' })
  const body = await response.json().catch(() => null) as { library?: unknown } | null
  if (!response.ok || !Array.isArray(body?.library)) throw new Error('library_unavailable')
  return body.library as LibraryFile[]
}

export function libraryFileUrl(id: string) {
  return withBasePath(`/api/mobile/artifacts/${encodeURIComponent(id)}`)
}

/** Deletes one of the person's own files; anything but success throws, so the row stays. */
export async function deleteLibraryFile(id: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(libraryFileUrl(id), { method: 'DELETE', credentials: 'same-origin' })
  if (!response.ok) throw new Error(response.status === 404 ? 'not_found' : 'delete_failed')
}
