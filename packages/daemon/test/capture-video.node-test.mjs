import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, open, readFile, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { promisify } from 'node:util'
import { CAPTURE_VIDEO_MAX_BYTES, normalizeRecordingSteps, processCaptureVideo, recordingWindows } from '../src/agents/capture-video.mjs'

const execute = promisify(execFile)
const run = (binary, args) => execute(binary, args, { maxBuffer: 1_000_000 })
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'capture-video-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function flow(path) {
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10:d=16', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=10:d=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path])
}
async function pixel(path, last = false) {
  const { stdout } = await execute('ffmpeg', ['-v', 'error', ...(last ? ['-sseof', '-0.2'] : []), '-i', path,
    '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' })
  return [...stdout]
}
const steps = [
  { atMs: 1500, durationMs: 1000, label: 'First action', source: 'action' },
  { atMs: 19_500, durationMs: 1000, label: 'Final action', source: 'action' },
]

test('only complete action timing proves a gap is safe to remove', () => {
  assert.deepEqual(recordingWindows(20_000, steps), [{ startMs: 0, endMs: 3000 }, { startMs: 17500, endMs: 20_000 }])
  assert.deepEqual(recordingWindows(20_000, [{ ...steps[0], durationMs: undefined }, steps[1]]), [{ startMs: 0, endMs: 20_000 }])
  assert.deepEqual(recordingWindows(20_000, [{ atMs: 1000, label: 'Result', source: 'mark' }]), [{ startMs: 0, endMs: 20_000 }])
  // A long-running action retains its whole execution, not a guessed window around its end.
  assert.deepEqual(recordingWindows(20_000, [{ ...steps[1], durationMs: 19_000 }]), [{ startMs: 0, endMs: 20_000 }])
  assert.throws(() => normalizeRecordingSteps([{ ...steps[0], durationMs: -1 }]), /captureVideoStepsInvalid/)
})

test('real FFmpeg removes idle time and preserves the first and last actions with mapped steps', async t => {
  const directory = await workspace(t), input = join(directory, 'source.mp4'), output = join(directory, 'processed.mp4')
  await flow(input)
  const result = await processCaptureVideo(input, output, { steps })
  assert.equal(result.processing.originalDurationMs, 20_000)
  assert.equal(result.processing.trimmedMs, 14_500)
  assert.ok(Math.abs(result.durationMs - 5500) < 150)
  assert.deepEqual(result.steps.map(step => step.atMs), [1500, 5000])
  const first = await pixel(output), last = await pixel(output, true)
  assert.ok(first[0] > 180 && first[2] < 60, 'first red action survives')
  assert.ok(last[2] > 180 && last[0] < 60, 'last blue action survives')
  assert.ok((await stat(input)).size > 0, 'processing never destroys its input before publication')
})

test('real FFmpeg compacts a video over the 100 MB publication limit without truncating its final action', async t => {
  const directory = await workspace(t), input = join(directory, 'oversized.mp4'), output = join(directory, 'processed.mp4')
  await flow(input)
  // A legal MP4 free atom makes a sparse, oversized real input without burning CPU or disk.
  const handle = await open(input, 'r+')
  const before = (await handle.stat()).size, atomSize = CAPTURE_VIDEO_MAX_BYTES + 1
  const header = Buffer.alloc(8); header.writeUInt32BE(atomSize, 0); header.write('free', 4)
  await handle.write(header, 0, header.length, before)
  await handle.truncate(before + atomSize)
  await handle.close()
  const result = await processCaptureVideo(input, output, { steps })
  assert.ok(result.processing.originalSize > CAPTURE_VIDEO_MAX_BYTES)
  assert.ok(result.size < CAPTURE_VIDEO_MAX_BYTES)
  assert.ok(result.processing.trimmedMs > 0)
  const last = await pixel(output, true)
  assert.ok(last[2] > 180 && last[0] < 60)
})

test('bitrate fallback fits a small real budget while retaining the full unmarked video duration', async t => {
  const directory = await workspace(t), input = join(directory, 'motion.mp4'), output = join(directory, 'small.mp4')
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p', input])
  const maximum = 35_000
  const result = await processCaptureVideo(input, output, { maxBytes: maximum })
  assert.ok(result.processing.originalSize > maximum)
  assert.ok(result.size <= maximum)
  assert.ok(Math.abs(result.durationMs - 4000) < 150)
  assert.equal(result.processing.trimmedMs, 0, 'no timing metadata is not evidence of idle time')
  assert.ok((await pixel(output, true)).length === 3, 'tail is still decodable')
})

test('refuses symlinks, malformed media and an impossible output budget without publishing a file', async t => {
  const directory = await workspace(t), input = join(directory, 'flow.mp4'), link = join(directory, 'link.mp4'), output = join(directory, 'output.mp4')
  await flow(input); await symlink(input, link)
  await assert.rejects(processCaptureVideo(link, output))
  await assert.rejects(processCaptureVideo(input, output, { maxBytes: 1 }), /captureVideoTooLarge/)
  await assert.rejects(readFile(output), { code: 'ENOENT' })
})
