import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CAPTURE_MAX_BYTES, sniffCaptureType } from '@mikka/protocol/capture'
import { capturePosterBinary } from './poster-binary.mjs'

const execute = promisify(execFile)
export const CAPTURE_POSTER_MAX_BYTES = 256_000

export { capturePosterBinary }

/** Decode the first real frame of an immutable MP4/WebM. The decoder gets only
 * a private local file, a video-only demuxer and no network protocols. */
export async function renderCapturePoster(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const contentType = sniffCaptureType(bytes)
  if (!['video/mp4','video/webm'].includes(contentType ?? '') || !bytes.length || bytes.length > CAPTURE_MAX_BYTES.video)
    throw new Error('capturePosterInputInvalid')
  signal?.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'mikka-capture-poster-'))
  try {
    const input = join(directory, contentType === 'video/mp4' ? 'capture.mp4' : 'capture.webm')
    const output = join(directory, 'poster.jpg')
    await writeFile(input, bytes, { mode: 0o600 })
    try {
      await execute(await capturePosterBinary(), ['-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1',
        '-max_alloc','33554432','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm',
        '-i',input,'-map','0:v:0','-frames:v','1','-vf',"scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",'-q:v','5',
        '-map_metadata','-1','-map_chapters','-1','-an','-sn','-dn','-threads','1','-f','image2',output],
      { timeout: 15_000, maxBuffer: 64 * 1024, signal, windowsHide: true })
    } catch (error) { throw new Error('capturePosterProcessingFailed', { cause: error }) }
    signal?.throwIfAborted()
    const image = new Uint8Array(await readFile(output))
    if (sniffCaptureType(image) !== 'image/jpeg' || image.length > CAPTURE_POSTER_MAX_BYTES) throw new Error('capturePosterOutputInvalid')
    return image
  } finally { await rm(directory, { recursive: true, force: true }) }
}
