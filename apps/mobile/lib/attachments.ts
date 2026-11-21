import { Platform } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File, Paths } from 'expo-file-system'
import { EncodingType, writeAsStringAsync } from 'expo-file-system/legacy'
import type { ClipboardImage } from 'expo-clipboard'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { fetch as nativeFetch } from 'expo/fetch'
import { CHAT_FILE_MAX_BYTES, chatFileSchema, supportedChatFile, type ChatFile, type ChatFileScope } from '@mikka/protocol/chat-attachments'
import { api, apiConnection, ApiError, authHeaders } from './api'

/**
 * What the composer's 「+」 attaches. The server takes up to two images, each
 * PNG, JPEG or WebP and at most 1 MB (`lib/coordinator/user-attachments.ts`),
 * so a photo is scaled and re-encoded as JPEG until it fits. A text file
 * travels in the message as its contents under its name, the way the web
 * attaches one (`lib/text-attachment.ts`).
 */
export type Attachment =
  | { key: string; kind: 'image'; uri: string; dataUrl: string }
  | { key: string; kind: 'text'; name: string; block: string }
  | { key: string; kind: 'file'; name: string; uri: string; mediaType: string; size: number; file?: globalThis.File; state: 'uploading' | 'ready' | 'error'; uploaded?: ChatFile; error?: string }

export const MAX_IMAGES = 2
const MAX_IMAGE_BYTES = 1024 * 1024
/** The server's limit on one message (lib/message-limits.ts). */
export const MESSAGE_MAX = 10_000

const TEXT_NAME = /\.(?:txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|html?|css|log|[cm]?[jt]sx?|py|go|rs|java|rb|sh|sql)$/i
const TEXT_TYPES = ['text/*', 'application/json', 'application/xml', 'application/x-yaml', 'application/javascript', 'application/x-sh', 'application/sql']

let counter = 0
const key = () => `a${Date.now().toString(36)}${(counter++).toString(36)}`

/** Long side and JPEG quality tried in turn until the photo fits under 1 MB. */
const STEPS = [[2048, 0.8], [1600, 0.7], [1280, 0.6], [1024, 0.5]] as const

async function fit(uri: string, width: number, height: number): Promise<Attachment | null> {
  for (const [side, compress] of STEPS) {
    const scale = Math.min(1, side / Math.max(width || side, height || side))
    const context = ImageManipulator.manipulate(uri)
    if (scale < 1) context.resize(width >= height ? { width: Math.round(width * scale) } : { height: Math.round(height * scale) })
    const image = await context.renderAsync()
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true })
    const base64 = saved.base64 ?? ''
    if (base64 && base64.length * 0.75 <= MAX_IMAGE_BYTES) return { key: key(), kind: 'image', uri: saved.uri, dataUrl: `data:image/jpeg;base64,${base64}` }
  }
  return null
}

/** Photos from the library (`library`) or a new one from the camera; null when the person cancelled or refused access. */
export async function pickImages(from: 'camera' | 'library', room: number): Promise<Attachment[] | null> {
  if (room <= 0) return []
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, allowsMultipleSelection: from === 'library' && room > 1, selectionLimit: room }
  if (from === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) return null
  }
  const result = from === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options)
  if (result.canceled) return null
  const images = await Promise.all(result.assets.slice(0, room).map(asset => fit(asset.uri, asset.width, asset.height)))
  return images.filter((image): image is Attachment => image !== null)
}

/** A text file as a fenced block under its name, or a reason it cannot go: not text, or too long. */
export async function pickText(): Promise<Attachment | 'notText' | 'tooLong' | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: Platform.OS === 'web' ? undefined : TEXT_TYPES, copyToCacheDirectory: true, multiple: false })
  if (result.canceled || !result.assets[0]) return null
  const asset = result.assets[0]
  if (!asset.mimeType?.startsWith('text/') && !TEXT_NAME.test(asset.name)) return 'notText'
  const text = asset.file ? await asset.file.text() : await new File(asset.uri).text()
  const block = `${asset.name}\n\`\`\`\n${text.replace(/\n$/, '')}\n\`\`\``
  if (block.length > MESSAGE_MAX) return 'tooLong'
  return { key: key(), kind: 'text', name: asset.name, block }
}

/** The system file picker, shared by bot chats, groups and Agent threads. */
export async function pickChatFile(): Promise<Extract<Attachment, { kind: 'file' }> | 'unsupported' | 'unreadable' | 'tooLarge' | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false })
  if (result.canceled || !result.assets[0]) return null
  const asset = result.assets[0]
  if (!supportedChatFile(asset.name, asset.mimeType)) return 'unsupported'
  const size = asset.size ?? asset.file?.size ?? new File(asset.uri).size
  if (!size) return 'unreadable'
  if (size > CHAT_FILE_MAX_BYTES) return 'tooLarge'
  return { key: key(), kind: 'file', name: asset.name, uri: asset.uri, mediaType: asset.mimeType ?? '', size, file: asset.file, state: 'uploading' }
}
interface UploadTicket { id: string; chunkSize?: number; nextPart?: number; uploadUrl?: string; headers?: Record<string, string>; uploaded?: boolean }
const uploadTickets = new Map<string, UploadTicket>()
export async function uploadPickedFile(item: Extract<Attachment, { kind: 'file' }>, scope: ChatFileScope): Promise<ChatFile> {
  const connection = apiConnection()
  const request: typeof api = (path, init) => api(path, init, connection)
  const baseUrl = connection.account.server.url
  const body = item.file ?? new File(item.uri)
  const ticketKey = `${connection.account.id}:${scope.kind}:${scope.id}:${item.key}`
  let started = uploadTickets.get(ticketKey)
  if (!started) {
    started = await request<UploadTicket>('/api/chat/attachments', { method: 'POST', body: { operation: 'init', scope, name: item.name, mediaType: item.mediaType, size: body.size } })
    uploadTickets.set(ticketKey, started)
  } else {
    try { return chatFileSchema.parse(await request(`/api/chat/attachments/${started.id}?info`)) } catch { /* Completion may still be pending. Reuse its identity. */ }
  }
  if (started.chunkSize) {
    const ticket = started, chunkSize = started.chunkSize
    try {
      for (let part = ticket.nextPart ?? 0; part < Math.ceil(body.size / chunkSize); part++) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120_000)
        const response = await nativeFetch(`${baseUrl}/api/chat/attachments?id=${ticket.id}&part=${part}`, { method: 'POST', credentials: Platform.OS === 'web' ? 'include' : 'omit', redirect: 'error', headers: { ...await authHeaders(connection), 'content-type': 'application/octet-stream' }, body: body.slice(part * chunkSize, (part + 1) * chunkSize), signal: controller.signal }).finally(() => clearTimeout(timer))
        if (!response.ok) { const data = await response.json().catch(() => null) as { error?: string } | null; throw new ApiError(response.status, data?.error ?? 'unavailable') }
        ticket.nextPart = part + 1
      }
      const uploaded = chatFileSchema.parse(await request('/api/chat/attachments', { method: 'POST', body: { operation: 'complete', id: ticket.id }, timeoutMs: 120_000 }))
      uploadTickets.delete(ticketKey)
      return uploaded
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) { uploadTickets.delete(ticketKey); void request(`/api/chat/attachments/${ticket.id}`, { method: 'DELETE' }).catch(() => {}) }
      throw error
    }
  }
  const direct = Boolean(started.uploadUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  const response = !started.uploaded ? await nativeFetch(started.uploadUrl ?? `${baseUrl}/api/chat/attachments?id=${started.id}`, {
    method: direct ? 'PUT' : 'POST', redirect: 'error', headers: direct ? started.headers : { ...await authHeaders(connection), 'content-type': 'application/octet-stream' }, body, signal: controller.signal,
  }).finally(() => clearTimeout(timer)) : (clearTimeout(timer), null)
  if (response && !response.ok) { uploadTickets.delete(ticketKey); void request(`/api/chat/attachments/${started.id}`, { method: 'DELETE' }).catch(() => {}); const data = await response.json().catch(() => null) as { error?: string } | null; throw Error(data?.error ?? 'unavailable') }
  if (direct) started.uploaded = true
  let completed: unknown
  try { completed = direct ? await request('/api/chat/attachments', { method: 'POST', body: { operation: 'complete', id: started.id }, timeoutMs: 120_000 }) : await response!.json() }
  catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      uploadTickets.delete(ticketKey)
      void request(`/api/chat/attachments/${started.id}`, { method: 'DELETE' }).catch(() => {})
    }
    throw error
  }
  const uploaded = chatFileSchema.parse(completed)
  uploadTickets.delete(ticketKey)
  return uploaded
}
export async function pastedChatImage(image: ClipboardImage): Promise<Extract<Attachment, { kind: 'file' }>> {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.data)
  if (!match) throw Error('unreadable')
  const id = key(), name = `clipboard-${id}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`
  const uri = `${Paths.cache.uri}${name}`
  await writeAsStringAsync(uri, match[2], { encoding: EncodingType.Base64 })
  const file = new File(uri)
  return { key: id, kind: 'file', name, uri, mediaType: `image/${match[1]}`, size: file.size, state: 'uploading' }
}

/** The message as the server takes it: the words, then each text file; the photos beside them (with their local file, for the sending bubble). */
export function outgoing(text: string, attachments: readonly Attachment[]) {
  const blocks = attachments.flatMap(item => item.kind === 'text' ? [item.block] : [])
  const images = attachments.flatMap(item => item.kind === 'image' ? [{ uri: item.uri, dataUrl: item.dataUrl }] : [])
  return { text: [text.trim(), ...blocks].filter(Boolean).join('\n\n'), images }
}
