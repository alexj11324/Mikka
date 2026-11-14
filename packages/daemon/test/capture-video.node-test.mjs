import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { CAPTURE_VIDEO_MAX_BYTES, normalizeRecordingSteps, processCaptureVideo, recordingWindows } from '../src/agents/capture-video.mjs'
import * as captureVideo from '../src/agents/capture-video.mjs'
import { installCaptureTools } from '../scripts/install-capture-tools.mjs'

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

test('private capture tools are one protected pair; a partial or writable install never falls back to PATH', async t => {
  const directory = await workspace(t), tools = join(directory, 'tools'), ownerId = process.getuid?.() ?? 0
  assert.deepEqual(await captureVideo.captureVideoBinaries({ directory: tools, ownerId }), { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  await mkdir(tools, { mode: 0o755 })
  await writeFile(join(tools, 'ffmpeg'), 'fixture', { mode: 0o555 })
  await assert.rejects(captureVideo.captureVideoBinaries({ directory: tools, ownerId }), { code: 'captureVideoDependencyUnavailable' })
  await writeFile(join(tools, 'ffprobe'), 'fixture', { mode: 0o555 })
  assert.deepEqual(await captureVideo.captureVideoBinaries({ directory: tools, ownerId }), { ffmpeg: join(tools, 'ffmpeg'), ffprobe: join(tools, 'ffprobe') })
  await chmod(join(tools, 'ffprobe'), 0o777)
  await assert.rejects(captureVideo.captureVideoBinaries({ directory: tools, ownerId }), { code: 'captureVideoDependencyUnavailable' })
  await rm(join(tools, 'ffprobe')); await symlink(join(tools, 'ffmpeg'), join(tools, 'ffprobe'))
  await assert.rejects(captureVideo.captureVideoBinaries({ directory: tools, ownerId }), { code: 'captureVideoDependencyUnavailable' })
})

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function toolchainFixture(id = 'fixture-v1', suffix = '') {
  const downloads = new Map(), assets = {}
  for (const [index, name] of ['ffmpeg', 'ffprobe', 'LICENSE', 'README'].entries()) {
    const bytes = Buffer.from(name + ': fixture bytes ' + suffix), gzip = index < 2
    const compressed = gzip ? gzipSync(bytes) : bytes, assetId = index + 1
    assets[name] = { assetId, gzip, downloadBytes: compressed.length, downloadSha256: hash(compressed), bytes: bytes.length, sha256: hash(bytes) }
    downloads.set(assetId, compressed)
  }
  return { toolchain: { id, assets }, fetchAsset: async asset => downloads.get(asset.assetId) }
}

test('tool installation is additive, offline-idempotent and preserves the previous release and official files', async t => {
  const directory = await workspace(t), root = join(directory, 'private'), official = join(directory, 'official-ffmpeg')
  await mkdir(root); await writeFile(official, 'official template original', { mode: 0o555 })
  const before = await stat(official), original = await readFile(official), first = toolchainFixture()
  const installed = await installCaptureTools({ root, ...first })
  assert.equal(installed.cached, false)
  const cached = await installCaptureTools({ root, toolchain: first.toolchain, fetchAsset: () => { throw new Error('Must not download a verified cache') } })
  assert.equal(cached.cached, true)
  const firstBytes = await readFile(join(installed.directory, 'ffmpeg'))
  const second = await installCaptureTools({ root, ...toolchainFixture('fixture-v2', 'new release') })
  assert.notEqual(second.directory, installed.directory)
  assert.deepEqual(await readFile(join(installed.directory, 'ffmpeg')), firstBytes)
  assert.deepEqual(await readFile(official), original)
  assert.equal((await stat(official)).mode, before.mode)
  assert.equal((await stat(official)).mtimeMs, before.mtimeMs)
  assert.deepEqual((await readdir(directory)).sort(), ['official-ffmpeg', 'private'])
  assert.deepEqual((await readdir(root)).sort(), ['fixture-v1', 'fixture-v2'])
})

test('compressed and decompressed hashes are both required before an atomic install becomes visible', async t => {
  const root = await workspace(t)
  for (const boundary of ['download', 'binary']) {
    const fixture = toolchainFixture('fixture-' + boundary)
    fixture.toolchain.assets.ffprobe[boundary === 'download' ? 'downloadSha256' : 'sha256'] = '0'.repeat(64)
    await assert.rejects(installCaptureTools({ root, ...fixture }), new RegExp(`capture_tools_${boundary}_hash_mismatch`))
    assert.deepEqual(await readdir(root), [], 'No partial version or failed staging directory is published')
  }
})

test('a private bootstrap umask still leaves the pinned tools readable and executable by the non-root worker', async t => {
  const root = await workspace(t), previous = process.umask(0o077)
  try {
    const installed = await installCaptureTools({ root, ...toolchainFixture() })
    assert.equal((await stat(installed.directory)).mode & 0o777, 0o755)
    assert.equal((await stat(join(installed.directory, 'ffmpeg'))).mode & 0o777, 0o555)
    assert.equal((await stat(join(installed.directory, 'ffprobe'))).mode & 0o777, 0o555)
    assert.equal((await stat(join(installed.directory, 'LICENSE'))).mode & 0o777, 0o444)
  } finally { process.umask(previous) }
})

test('an altered cached binary, symlink destination or escaping manifest is refused without overwriting it', async t => {
  const root = await workspace(t), fixture = toolchainFixture()
  const installed = await installCaptureTools({ root, ...fixture }), binary = join(installed.directory, 'ffmpeg')
  await chmod(binary, 0o755); await writeFile(binary, Buffer.alloc(fixture.toolchain.assets.ffmpeg.bytes, 1)); await chmod(binary, 0o555)
  await assert.rejects(installCaptureTools({ root, ...fixture }), /capture_tools_binary_hash_mismatch/)
  assert.deepEqual(await readFile(binary), Buffer.alloc(fixture.toolchain.assets.ffmpeg.bytes, 1), 'Do not repair/overwrite an unknown installation')
  const linked = toolchainFixture('linked')
  await symlink(installed.directory, join(root, linked.toolchain.id))
  await assert.rejects(installCaptureTools({ root, ...linked }), /capture_tools_directory_unsafe/)
  await assert.rejects(installCaptureTools({ root, ...toolchainFixture('..') }), /capture_tools_manifest_invalid/)
  assert.deepEqual((await readdir(root)).sort(), ['fixture-v1', 'linked'])
})

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
