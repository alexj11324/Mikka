import { z } from 'zod'

export const CHAT_FILE_CHUNK_BYTES = 3 * 1024 * 1024
export const CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024
export const CHAT_FILE_MAX_COUNT = 10
export const CHAT_FILE_MAX_TEXT = 200_000
export const chatFileScopeSchema = z
  .object({ kind: z.enum(['bot', 'group', 'thread']), id: z.uuid() })
  .strict()
export type ChatFileScope = z.infer<typeof chatFileScopeSchema>
export const chatFileSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(255),
  mediaType: z.string(),
  size: z.number().int().positive().max(CHAT_FILE_MAX_BYTES),
})
export type ChatFile = z.infer<typeof chatFileSchema>
export const chatFileDownloadSchema = chatFileSchema.extend({
  data: z.string().max(Math.ceil(CHAT_FILE_MAX_BYTES / 3) * 4 + 4),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().max(CHAT_FILE_MAX_TEXT).nullable(),
})
export const chatFileTransferSchema = z.union([
  chatFileDownloadSchema,
  chatFileDownloadSchema.omit({ data: true }).extend({ downloadUrl: z.url() }),
])
export type ChatFileDownload = z.infer<typeof chatFileDownloadSchema>

const TEXT_EXTENSIONS =
  'txt md markdown mdx rst csv tsv json jsonl ndjson yaml yml toml xml html htm css scss sass less log js jsx ts tsx mjs cjs mts cts py ipynb go rs java rb sh bash zsh fish sql c h cc cpp cxx hpp cs swift kt kts scala php vue svelte dart ex exs erl hs lua pl r jl tex ini cfg conf properties diff patch graphql gql proto dockerfile makefile env gitignore gitconfig editorconfig'
export const CHAT_TEXT_EXTENSIONS = new Set(TEXT_EXTENSIONS.split(' '))
export const CHAT_DOCUMENT_EXTENSIONS = new Set('pdf docx xlsx xls pptx odt ods odp rtf epub'.split(' '))
export const CHAT_IMAGE_EXTENSIONS = new Set('png jpg jpeg webp gif'.split(' '))
export const CHAT_AUDIO_EXTENSIONS = new Set('wav mp3 mpeg oga ogg flac aac m4a webm mp4 pcm'.split(' '))
export const CHAT_FILE_ACCEPT =
  [...CHAT_TEXT_EXTENSIONS, ...CHAT_DOCUMENT_EXTENSIONS, ...CHAT_IMAGE_EXTENSIONS, ...CHAT_AUDIO_EXTENSIONS]
    .map((ext) => `.${ext}`)
    .join(',') + ',text/*'
export const fileExtension = (name: string) => name.toLowerCase().split('.').at(-1) ?? ''
export function supportedChatFile(name: string, mediaType = '') {
  const ext = fileExtension(name)
  return (
    mediaType.startsWith('text/') ||
    CHAT_TEXT_EXTENSIONS.has(ext) ||
    CHAT_DOCUMENT_EXTENSIONS.has(ext) ||
    CHAT_IMAGE_EXTENSIONS.has(ext) ||
    CHAT_AUDIO_EXTENSIONS.has(ext)
  )
}

/** Small immutable references travel through existing text/outbox/retry contracts. Bytes never enter the draft. */
export function chatFileReference(file: Pick<ChatFile, 'id' | 'name'>) {
  return `[mikka-file:${file.id}:${encodeURIComponent(file.name)}]`
}
export function splitChatFiles(text: string): { text: string; files: Pick<ChatFile, 'id' | 'name'>[] } {
  const files: Pick<ChatFile, 'id' | 'name'>[] = []
  const words = text.replace(
    /\[mikka-file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([^\]\r\n]{1,2048})\]/gi,
    (match, id: string, encoded: string) => {
      try {
        const name = decodeURIComponent(encoded)
        if (!name || name.length > 255) return match
        files.push({ id: id.toLowerCase(), name })
        return ''
      } catch {
        return match
      }
    },
  )
  const body =
    text.startsWith('[mikka-file:') && words.startsWith('\n'.repeat(files.length + 1))
      ? words.slice(files.length + 1)
      : files.length
        ? words.trimEnd()
        : words
  return { text: body, files: [...new Map(files.map((file) => [file.id, file])).values()] }
}
export function withChatFiles(text: string, files: readonly Pick<ChatFile, 'id' | 'name'>[]) {
  return files.length ? `${files.map(chatFileReference).join('\n')}\n\n${text}` : text
}
