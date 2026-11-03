import {
  CHAT_AUDIO_EXTENSIONS,
  CHAT_DOCUMENT_EXTENSIONS,
  CHAT_FILE_MAX_BYTES,
  CHAT_FILE_MAX_TEXT,
  CHAT_IMAGE_EXTENSIONS,
  CHAT_TEXT_EXTENSIONS,
  fileExtension,
} from '@mikka/protocol/chat-attachments'

export class ChatFileError extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'tooLarge'
      | 'unreadable'
      | 'tooLong'
      | 'notFound'
      | 'tooMany'
      | 'unavailable'
      | 'audioKeyRequired',
  ) {
    super(code)
  }
}
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  pcm: 'audio/pcm',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
}
export async function extractChatFile(
  name: string,
  inputType: string,
  data: Uint8Array,
): Promise<{ mediaType: string; text: string | null }> {
  if (!data.length) throw new ChatFileError('unreadable')
  if (data.length > CHAT_FILE_MAX_BYTES) throw new ChatFileError('tooLarge')
  const ext = fileExtension(name)
  if (
    CHAT_TEXT_EXTENSIONS.has(ext) ||
    (inputType.startsWith('text/') && !CHAT_DOCUMENT_EXTENSIONS.has(ext))
  ) {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    } catch {
      throw new ChatFileError('unreadable')
    }
    if (text.includes('\0')) throw new ChatFileError('unreadable')
    if (text.length > CHAT_FILE_MAX_TEXT) throw new ChatFileError('tooLong')
    return {
      mediaType: ext === 'md' || ext === 'markdown' || ext === 'mdx' ? 'text/markdown' : 'text/plain',
      text,
    }
  }
  if (CHAT_IMAGE_EXTENSIONS.has(ext)) {
    const { default: sharp } = await import('sharp')
    const meta = await sharp(data, { limitInputPixels: 40_000_000 })
      .metadata()
      .catch(() => null)
    if (!meta || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format ?? ''))
      throw new ChatFileError('unreadable')
    return { mediaType: MIME[meta.format === 'jpeg' ? 'jpg' : meta.format!], text: null }
  }
  if (CHAT_AUDIO_EXTENSIONS.has(ext)) {
    if (ext !== 'pcm') {
      const { parseBuffer, TrackType } = await import('music-metadata')
      const meta = await parseBuffer(
        data,
        { mimeType: MIME[ext], size: data.length },
        { duration: true, skipCovers: true },
      ).catch(() => null)
      if (
        !meta ||
        meta.format.trackInfo.some((track) => track.type === TrackType.video) ||
        !meta.format.numberOfChannels ||
        !meta.format.sampleRate
      )
        throw new ChatFileError('unreadable')
    }
    return { mediaType: MIME[ext], text: null }
  }
  if (!CHAT_DOCUMENT_EXTENSIONS.has(ext)) throw new ChatFileError('unsupported')
  try {
    let text: string
    if (ext === 'xls') {
      const xlsx = await import('@e965/xlsx')
      const book = xlsx.read(data, { type: 'array', cellDates: true })
      text = book.SheetNames.map(
        (sheet) => `# ${sheet}\n${xlsx.utils.sheet_to_csv(book.Sheets[sheet])}`,
      ).join('\n\n')
    } else {
      const { OfficeParser } = await import('officeparser')
      const doc = await OfficeParser.parseOffice(data, {
        fileType: ext as 'pdf',
        extractAttachments: false,
        decompressionLimits: { maxUncompressedBytes: 64 * 1024 * 1024, maxZipEntries: 5000 },
      })
      if (doc.warnings.some((warning) => /LIMIT|TRUNCATED/.test(warning.code)))
        throw new ChatFileError('tooLong')
      if (ext === 'xlsx' || ext === 'ods') {
        const sheets = [...doc.content],
          rendered: string[] = []
        for (const sheet of sheets) {
          doc.content = [sheet]
          rendered.push(
            `# ${sheet.type === 'sheet' ? (sheet.metadata?.sheetName ?? 'Sheet') : 'Sheet'}\n${(await doc.to('md', { includeImages: 'none' })).value}`,
          )
        }
        text = rendered.join('\n\n')
      } else text = (await doc.to('md', { includeImages: 'none' })).value as string
    }
    if (text.length > CHAT_FILE_MAX_TEXT) throw new ChatFileError('tooLong')
    if (!text.trim() && ext !== 'pdf') throw new ChatFileError('unreadable')
    return { mediaType: MIME[ext] ?? 'application/octet-stream', text: text.trim() || null }
  } catch (error) {
    if (error instanceof ChatFileError) throw error
    throw new ChatFileError('unreadable')
  }
}

/** Enforce the declared upload budget while reading remote storage, before buffering the object. */
export async function boundedChatFileBytes(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > expectedSize || size > CHAT_FILE_MAX_BYTES) {
        await reader.cancel()
        throw new ChatFileError('tooLarge')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (size !== expectedSize) throw new ChatFileError('unreadable')
  return Buffer.concat(chunks)
}
