import { chatFileSchema, type ChatFile, type ChatFileScope } from '@mikka/protocol/chat-attachments'
import { pageRefreshSignal } from '@/lib/app-build'
import { withBasePath } from '@/lib/base-path'

export class ChatUploadError extends Error {
  constructor(
    readonly code: string,
    readonly definitive = false,
  ) {
    super(code)
  }
}
async function result(response: Response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new ChatUploadError(typeof body.error === 'string' ? body.error : 'unavailable', true)
  return body
}
interface UploadTicket {
  id: string
  chunkSize?: number
  nextPart?: number
  uploadUrl?: string
  headers?: Record<string, string>
  uploaded?: boolean
  completeAttempted?: boolean
  createdAt: number
}
const tickets = new WeakMap<File, Map<string, UploadTicket>>()

async function uploadPart(body: Blob, url: string, signal: AbortSignal, progress: (loaded: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => {
      xhr.abort()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const fail = () => {
      signal.removeEventListener('abort', abort)
      reject(new ChatUploadError('unavailable'))
    }
    xhr.open('POST', url)
    xhr.withCredentials = true
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(event.loaded)
    }
    xhr.onerror = fail
    xhr.timeout = 120_000
    xhr.ontimeout = fail
    xhr.onload = () => {
      signal.removeEventListener('abort', abort)
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else {
        let code = xhr.status === 413 ? 'tooLarge' : 'unavailable'
        try {
          code = JSON.parse(xhr.responseText).error ?? code
        } catch {}
        reject(new ChatUploadError(code, true))
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    xhr.send(body)
  })
}

export async function uploadChatFile(
  file: File,
  scope: ChatFileScope,
  signal: AbortSignal,
  progress: (state: 'uploading' | 'processing', percent: number) => void,
): Promise<ChatFile> {
  const refresh = pageRefreshSignal()
  signal = AbortSignal.any([signal, refresh])
  signal.throwIfAborted()
  const endpoint = withBasePath('/api/chat/attachments')
  const scopeKey = `${scope.kind}:${scope.id}`
  const scopes = tickets.get(file) ?? new Map<string, UploadTicket>()
  tickets.set(file, scopes)
  let started = scopes.get(scopeKey)
  if (started) {
    const recovered = await fetch(`${endpoint}/${started.id}?info`, { credentials: 'same-origin', signal })
    if (recovered.ok) return chatFileSchema.parse(await recovered.json())
    if (started.uploadUrl && !started.completeAttempted && Date.now() - started.createdAt > 240_000) {
      void fetch(`${endpoint}/${started.id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(
        () => {},
      )
      scopes.delete(scopeKey)
      started = undefined
    }
  }
  if (!started) {
    const initialized = await result(
      await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'init',
          scope,
          name: file.name,
          size: file.size,
          mediaType: file.type,
        }),
      }),
    )
    started = { ...initialized, createdAt: Date.now() } as UploadTicket
    scopes.set(scopeKey, started)
  }
  const ticket = started
  const direct = typeof ticket.uploadUrl === 'string'
  let uploaded: unknown
  try {
    if (ticket.chunkSize) {
      const chunkSize = ticket.chunkSize
      for (let part = ticket.nextPart ?? 0; part < Math.ceil(file.size / chunkSize); part++) {
        const offset = part * chunkSize
        await uploadPart(
          file.slice(offset, offset + chunkSize),
          `${endpoint}?id=${ticket.id}&part=${part}`,
          signal,
          (loaded) => progress('uploading', Math.round(((offset + loaded) / file.size) * 100)),
        )
        ticket.nextPart = part + 1
      }
      ticket.completeAttempted = true
      progress('processing', 100)
      return chatFileSchema.parse(
        await result(
          await fetch(endpoint, {
            method: 'POST',
            credentials: 'same-origin',
            signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operation: 'complete', id: ticket.id }),
          }),
        ),
      )
    }
    if (!ticket.uploaded)
      uploaded = await new Promise<unknown>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const abort = () => {
          xhr.abort()
          reject(new DOMException('Cancelled', 'AbortError'))
        }
        xhr.open(direct ? 'PUT' : 'POST', ticket.uploadUrl ?? `${endpoint}?id=${ticket.id}`)
        xhr.withCredentials = !direct
        for (const [key, value] of Object.entries(
          direct ? (ticket.headers ?? {}) : { 'content-type': 'application/octet-stream' },
        ))
          xhr.setRequestHeader(key, String(value))
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable)
            progress(
              event.loaded === event.total ? 'processing' : 'uploading',
              Math.round((event.loaded / event.total) * 100),
            )
        }
        xhr.onerror = () => {
          signal.removeEventListener('abort', abort)
          reject(new ChatUploadError('unavailable'))
        }
        xhr.timeout = 120_000
        xhr.ontimeout = xhr.onerror
        xhr.onload = () => {
          signal.removeEventListener('abort', abort)
          let body: unknown = {}
          try {
            body = JSON.parse(xhr.responseText)
          } catch {
            /* R2 PUT has an empty response. */
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(body)
          else
            reject(
              new ChatUploadError(
                typeof body === 'object' && body && 'error' in body
                  ? String(body.error)
                  : xhr.status === 413
                    ? 'tooLarge'
                    : 'unavailable',
                true,
              ),
            )
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          return
        }
        if (!direct) ticket.completeAttempted = true
        xhr.send(file)
      })
    if (!direct) return chatFileSchema.parse(uploaded)
    ticket.uploaded = true
    ticket.completeAttempted = true
    progress('processing', 100)
    return chatFileSchema.parse(
      await result(
        await fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'complete', id: ticket.id }),
        }),
      ),
    )
  } catch (error) {
    if (!refresh.aborted && (signal.aborted || (error instanceof ChatUploadError && error.definitive))) {
      scopes.delete(scopeKey)
      void fetch(`${endpoint}/${ticket.id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {})
    }
    throw error
  }
}
