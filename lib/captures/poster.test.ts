import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import sharp from 'sharp'
import { capturePosterBinary, CAPTURE_POSTER_MAX_BYTES, renderCapturePoster } from './poster'

const run = promisify(execFile)

test('video covers decode a real private frame, bounded to 640 pixels and JPEG size', async () => {
  const directory = await mkdtemp(join(tmpdir(),'capture-poster-test-'))
  try {
    const path = join(directory,'real-video.mp4')
    await run(await capturePosterBinary(),['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=1280x720:d=0.12',
      '-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',path],{timeout:15_000})
    const image = await renderCapturePoster(new Uint8Array(await readFile(path)))
    const metadata = await sharp(image).metadata()
    assert.equal(metadata.format,'jpeg')
    assert.equal(metadata.width,640)
    assert.equal(metadata.height,360)
    assert.ok(image.length > 100 && image.length <= CAPTURE_POSTER_MAX_BYTES)
    const pixel = await sharp(image).resize(1,1).removeAlpha().raw().toBuffer()
    assert.ok(pixel[0] > 230 && pixel[1] < 20 && pixel[2] < 20,'cover is the red source frame, not a placeholder')
  } finally { await rm(directory,{recursive:true,force:true}) }
})

test('invalid media and cancelled work produce no fabricated poster and preserve decoder causes', async () => {
  await assert.rejects(renderCapturePoster(Buffer.from('<html>not a video</html>')),/capturePosterInputInvalid/)
  const malformed = new Uint8Array([0,0,0,24,...Buffer.from('ftypisom-malformed')])
  await assert.rejects(renderCapturePoster(malformed), error => error instanceof Error && error.message === 'capturePosterProcessingFailed' && error.cause instanceof Error)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(renderCapturePoster(malformed,controller.signal), error => error instanceof Error && error.name === 'AbortError')
})
