// The one video finalizer for run captures, used by the daemon and copied into
// the run's cloud computer. It never uploads, publishes, or creates a store.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import { devNull } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const CAPTURE_RAW_MAX_BYTES = 1_000_000_000
export const CAPTURE_VIDEO_MAX_BYTES = 100_000_000
// Reuse ffmpeg-static@5.3.0's upstream release, including its matching ffprobe.
// The tag is b6.1.1; these Linux assets actually report 7.0.2-static. Pin their
// bytes, not the tag's display name. This module is also copied by itself into
// computer VMs, so the immutable private path must not need another JS file.
export const CAPTURE_TOOLCHAIN = {
  id: 'ffmpeg-static-b6.1.1-linux-x64-e7e7fb30477f-4f231a1960d8',
  release: 'https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1',
  version: '7.0.2-static',
  assets: {
    ffmpeg: { assetId: 316528626, gzip: true, downloadBytes: 29354986, downloadSha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
      bytes: 79826272, sha256: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99' },
    ffprobe: { assetId: 316529539, gzip: true, downloadBytes: 29276839, downloadSha256: '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
      bytes: 79665792, sha256: '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d' },
    LICENSE: { assetId: 316529924, gzip: false, downloadBytes: 35147, downloadSha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
      bytes: 35147, sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },
    README: { assetId: 316529927, gzip: false, downloadBytes: 2235, downloadSha256: '72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537',
      bytes: 2235, sha256: '72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537' },
  },
}
export const CAPTURE_TOOLS_ROOT = '/opt/mikka/runtime/capture-tools'
export const CAPTURE_TOOLS_DIRECTORY = `${CAPTURE_TOOLS_ROOT}/${CAPTURE_TOOLCHAIN.id}`
const MAX_STEPS = 200
const MAX_DURATION_MS = 3_600_000
const PADDING_BEFORE_MS = 1_000
const PADDING_AFTER_MS = 1_500

export class CaptureVideoError extends Error {
  constructor(code, options) { super(code, options); this.name = 'CaptureVideoError'; this.code = code }
}

/** Ordinary local daemons retain their documented PATH dependency. An
 * installed private runtime is complete, root-owned and not task-writable;
 * never silently mix one private binary with another found on PATH. */
export async function captureVideoBinaries({ directory = CAPTURE_TOOLS_DIRECTORY, ownerId = 0 } = {}) {
  const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
  try {
    if (!info.isDirectory() || info.uid !== ownerId || (info.mode & 0o022)) throw new Error('Private capture tools directory is unsafe')
    const binaries = { ffmpeg: join(directory, 'ffmpeg'), ffprobe: join(directory, 'ffprobe') }
    for (const path of Object.values(binaries)) {
      const binary = await lstat(path)
      if (!binary.isFile() || binary.uid !== ownerId || (binary.mode & 0o022) || !(binary.mode & 0o111)) throw new Error('Private capture tool is unsafe')
    }
    return binaries
  } catch (error) { throw new CaptureVideoError('captureVideoDependencyUnavailable', { cause: error }) }
}

/** atMs is the action's completion point; durationMs is actual execution time. */
export function normalizeRecordingSteps(input = []) {
  if (!Array.isArray(input) || input.length > MAX_STEPS) throw new CaptureVideoError('captureVideoStepsInvalid')
  return input.map(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step) ||
        !Number.isSafeInteger(step.atMs) || step.atMs < 0 || step.atMs > MAX_DURATION_MS ||
        !['action', 'mark'].includes(step.source) || typeof step.label !== 'string' ||
        !step.label.trim() || step.label.length > 200 ||
        (step.durationMs != null && (step.source !== 'action' || !Number.isSafeInteger(step.durationMs) || step.durationMs < 0 || step.durationMs > MAX_DURATION_MS)))
      throw new CaptureVideoError('captureVideoStepsInvalid')
    return { atMs: step.atMs, label: step.label.replace(/\s+/g, ' ').trim(), source: step.source,
      ...(step.durationMs == null ? {} : { durationMs: step.durationMs }) }
  }).sort((left, right) => left.atMs - right.atMs)
}

/** Unknown action timing keeps the original; an end marker alone is not proof of idle time. */
export function recordingWindows(durationMs, rawSteps = []) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS)
    throw new CaptureVideoError('captureVideoDurationInvalid')
  const steps = normalizeRecordingSteps(rawSteps)
  const actions = steps.filter(step => step.source === 'action')
  if (!actions.length || actions.some(step => step.durationMs == null) || steps.some(step => step.atMs > durationMs + PADDING_AFTER_MS))
    return [{ startMs: 0, endMs: durationMs }]
  // Only cut BETWEEN measured actions. Preserve startup and the whole tail:
  // a last long action can still be running when automatic recording stops.
  const windows = [{ startMs: 0, endMs: Math.min(actions[0].atMs + PADDING_AFTER_MS, durationMs) },
    ...steps.map(step => ({ startMs: Math.max(0, step.atMs - (step.durationMs ?? 0) - PADDING_BEFORE_MS),
      endMs: Math.min(durationMs, step.atMs + PADDING_AFTER_MS) })),
    { startMs: Math.max(0, actions.at(-1).atMs - actions.at(-1).durationMs - PADDING_BEFORE_MS), endMs: durationMs }]
    .filter(window => window.endMs > window.startMs).sort((a, b) => a.startMs - b.startMs)
  const merged = []
  for (const window of windows) {
    const previous = merged.at(-1)
    if (previous && window.startMs <= previous.endMs + 500) previous.endMs = Math.max(previous.endMs, window.endMs)
    else merged.push({ ...window })
  }
  return merged
}

export function remapRecordingSteps(rawSteps, windows, durationMs) {
  const point = atMs => {
    let kept = 0
    for (const window of windows) {
      if (atMs <= window.endMs) return Math.min(durationMs, Math.max(0, Math.round(kept + Math.max(0, atMs - window.startMs))))
      kept += window.endMs - window.startMs
    }
    return Math.min(durationMs, Math.round(kept))
  }
  return normalizeRecordingSteps(rawSteps).map(step => ({ ...step, atMs: point(step.atMs) }))
}

async function snapshot(source, destination, signal) {
  signal?.throwIfAborted()
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > CAPTURE_RAW_MAX_BYTES) throw new CaptureVideoError('captureVideoInputInvalid')
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const mp4 = bytesRead >= 12 && header.subarray(4, 8).toString() === 'ftyp'
    const webm = bytesRead >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && header.toString('latin1').includes('webm')
    if (!mp4 && !webm) throw new CaptureVideoError('captureVideoInputInvalid')
    const hash = createHash('sha256'), stream = handle.createReadStream({ autoClose: false, start: 0, end: info.size - 1 })
    stream.on('data', bytes => hash.update(bytes))
    await pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
    if ((await stat(destination)).size !== info.size) throw new CaptureVideoError('captureVideoInputChanged')
    return { size: info.size, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}

function videoFilter(windows, width, fps) {
  const seconds = milliseconds => (milliseconds / 1000).toFixed(3)
  const parts = windows.map((window, i) => `[0:v:0]trim=start=${seconds(window.startMs)}:end=${seconds(window.endMs)},setpts=PTS-STARTPTS[v${i}]`)
  const combined = windows.length === 1 ? '[v0]' : windows.map((_, i) => `[v${i}]`).join('') + `concat=n=${windows.length}:v=1:a=0,`
  return `${parts.join(';')};${combined}scale=w='min(${width},iw)':h=-2:force_divisible_by=2,fps=${fps},format=yuv420p[out]`
}

/** Re-encode whole retained windows. Never use -fs/-t: they silently discard the final actions. */
export async function processCaptureVideo(input, output, options = {}) {
  const maximum = options.maxBytes ?? CAPTURE_VIDEO_MAX_BYTES
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > CAPTURE_VIDEO_MAX_BYTES || resolve(input) === resolve(output))
    throw new CaptureVideoError('captureVideoOptionsInvalid')
  const steps = normalizeRecordingSteps(options.steps)
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 90_000, 180_000)
  const binaries = await captureVideoBinaries()
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(dirname(output), '.capture-process-'))
  await chmod(temporary, 0o700)
  const run = async (binary, args) => {
    options.signal?.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new CaptureVideoError('captureVideoProcessingTimeout')
    try { return await execute(binary, args, { timeout: remaining, maxBuffer: 256 * 1024, signal: options.signal, windowsHide: true }) }
    catch (error) { throw new CaptureVideoError(['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)
      ? 'captureVideoDependencyUnavailable' : 'captureVideoProcessingFailed', { cause: error }) }
  }
  const probe = async path => {
    const { stdout } = await run(binaries.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm',
      '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height,duration,nb_frames', '-of', 'json', path])
    let value
    try { value = JSON.parse(stdout) } catch (error) { throw new CaptureVideoError('captureVideoProbeInvalid', { cause: error }) }
    const stream = value.streams?.[0], seconds = Number(value.format?.duration ?? stream?.duration)
    if (!stream || !Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > MAX_DURATION_MS ||
        !Number.isSafeInteger(stream.width) || stream.width < 1 || !Number.isSafeInteger(stream.height) || stream.height < 1)
      throw new CaptureVideoError('captureVideoProbeInvalid')
    return { durationMs: Math.round(seconds * 1000), width: stream.width, height: stream.height }
  }
  try {
    const source = join(temporary, 'source.video')
    const originalFile = await snapshot(input, source, options.signal)
    const original = await probe(source)
    const windows = recordingWindows(original.durationMs, steps)
    const retainedMs = windows.reduce((total, window) => total + window.endMs - window.startMs, 0)
    const result = join(temporary, 'final.mp4')
    const base = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_complex_threads', '1',
      '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-i', source]
    const encode = async (width, fps, rate, pass) => {
      await run(binaries.ffmpeg, [...base, '-filter_complex', videoFilter(windows, width, fps), '-map', '[out]',
        '-map_metadata', '-1', '-map_chapters', '-1', '-an', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'veryfast',
        '-threads', '2', '-pix_fmt', 'yuv420p', ...(rate ? ['-b:v', `${rate}k`, '-pass', String(pass), '-passlogfile', join(temporary, 'pass')] : ['-crf', '28']),
        ...(pass === 1 ? ['-f', 'null', devNull] : ['-movflags', '+faststart', result])])
    }
    await encode(1280, 15)
    if ((await stat(result)).size > maximum) {
      // The budget covers the complete retained duration, with room for MP4 indexes.
      const rate = Math.floor(maximum * 0.82 * 8 / (retainedMs / 1000) / 1000)
      if (rate < 8) throw new CaptureVideoError('captureVideoTooLarge')
      for (const [width, fps, fraction] of [[960, 12, 1], [640, 10, 0.8]]) {
        await encode(width, fps, Math.max(8, Math.floor(rate * fraction)), 1)
        await encode(width, fps, Math.max(8, Math.floor(rate * fraction)), 2)
        if ((await stat(result)).size <= maximum) break
      }
    }
    const size = (await stat(result)).size
    if (size > maximum || size === 0) throw new CaptureVideoError('captureVideoTooLarge')
    const measured = await probe(result)
    if (measured.durationMs > MAX_DURATION_MS) throw new CaptureVideoError('captureVideoDurationInvalid')
    // Frame-boundary rounding is expected; a shorter file would hide evidence.
    if (Math.abs(measured.durationMs - retainedMs) > Math.max(250, windows.length * 100))
      throw new CaptureVideoError('captureVideoDurationMismatch')
    await chmod(result, 0o600)
    // Never follow an existing destination link.
    if (await lstat(output).catch(() => null)) throw new CaptureVideoError('captureVideoOutputExists')
    options.signal?.throwIfAborted()
    await rename(result, output)
    return { durationMs: measured.durationMs, size, steps: remapRecordingSteps(steps, windows, measured.durationMs),
      processing: { version: 1, originalDurationMs: original.durationMs, originalSize: originalFile.size, originalSha256: originalFile.sha256, trimmedMs: original.durationMs - retainedMs,
        retainedMs, windows, width: measured.width, height: measured.height } }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

// This check also stays false when esbuild inlines the helper into daemon entries.
if (process.argv[1] && basename(process.argv[1]) === 'capture-video.mjs' && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [, , input, output, metadata] = process.argv
    if (!input || !output || !metadata || process.argv.length !== 5) throw new CaptureVideoError('captureVideoOptionsInvalid')
    const options = JSON.parse(await readFile(metadata, 'utf8'))
    const result = await processCaptureVideo(input, output, options)
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    process.stderr.write((error instanceof CaptureVideoError ? error.code : 'captureVideoProcessingFailed') + '\n')
    process.exitCode = 1
  }
}
