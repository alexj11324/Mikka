import { Platform } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'

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

/** The message as the server takes it: the words, then each text file; the photos beside them (with their local file, for the sending bubble). */
export function outgoing(text: string, attachments: readonly Attachment[]) {
  const blocks = attachments.flatMap(item => item.kind === 'text' ? [item.block] : [])
  const images = attachments.flatMap(item => item.kind === 'image' ? [{ uri: item.uri, dataUrl: item.dataUrl }] : [])
  return { text: [text.trim(), ...blocks].filter(Boolean).join('\n\n'), images }
}
