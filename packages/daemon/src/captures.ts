// Uploads the screenshots and recordings a run's agent queued with
// `submit_capture` (agents/mikka-mcp.mjs). The run dir is the agent's to
// write, so nothing in it is trusted: no links are followed, and size, type
// and limits are checked again here and once more by the server, which binds
// the file to the run.
import { createHash } from "node:crypto"
import { closeSync, constants, createReadStream, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { CAPTURE_MAX_DURATION_MS, CAPTURE_MAX_BYTES, captureProblem, cleanCaptureTitle, sniffCaptureType } from "@mikka/protocol/capture"
import { DAEMON_RPC_ERRORS } from "@mikka/protocol"

import { DaemonError, ServerUnreachableError } from "./errors"
import type { Logger } from "./log"
import type { ServerLink } from "./server-link"
import { writeJsonAtomic } from "./fs-util"
import { CAPTURE_RAW_MAX_BYTES, normalizeRecordingSteps, processCaptureVideo, type RecordingStep, type ProcessedCaptureVideo } from './agents/capture-video.mjs'

/** Name of the captures dir inside a run dir. */
export const CAPTURES_DIR = "captures"
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EXTENSIONS = ["png", "jpg", "webp", "mp4", "webm"]

type Link = Pick<ServerLink, "beginCapture" | "resumeCapture" | "sendCapture" | "completeCapture">

/** A regular file's bytes, read without following a link; null otherwise. */
function readPlain(path: string, max: number): Uint8Array | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > max) return null
    return new Uint8Array(readFileSync(fd))
  } finally {
    closeSync(fd)
  }
}

const drop = (dir: string, id: string) => {
  for (const name of [`${id}.json`, ...EXTENSIONS.map((ext) => `${id}.${ext}`)]) rmSync(join(dir, name), { force: true })
}

/** Hash the same checked descriptor, without loading a large original into RAM. */
async function hashPlain(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size < 1 || info.size > CAPTURE_RAW_MAX_BYTES) throw new Error('Invalid capture video input')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, { fd, autoClose: false, start: 0, end: info.size - 1, signal })) hash.update(chunk)
    signal?.throwIfAborted()
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

/** Prepared bytes live in the daemon's existing pending area, never in agent metadata. */
async function prepareVideo(file: string, id: string, steps: RecordingStep[], pendingDir?: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const directory = pendingDir ?? mkdtempSync(join(tmpdir(), 'mikka-capture-pending-'))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const output = join(directory, `${id}.processed.mp4`), receipt = join(directory, `${id}.video.json`)
  try {
    const originalHash = await hashPlain(file, signal)
    const stepHash = createHash('sha256').update(JSON.stringify(steps)).digest('hex')
    let result: ProcessedCaptureVideo | undefined
    const previous = readPlain(receipt, 128_000)
    if (previous) {
      try {
        const cached = JSON.parse(new TextDecoder().decode(previous))
        if (cached.originalHash === originalHash && cached.stepHash === stepHash && cached.result?.processing?.version === 1 &&
            cached.result?.durationMs > 0 && cached.result.durationMs <= CAPTURE_MAX_DURATION_MS && await hashPlain(output, signal) === cached.sha256) result = cached.result
      } catch { /* A missing/invalid prepared file is rebuilt from the checked original. */ }
    }
    signal?.throwIfAborted()
    if (!result) {
      rmSync(output, { force: true }); rmSync(receipt, { force: true })
      result = await processCaptureVideo(file, output, { steps, maxBytes: CAPTURE_MAX_BYTES.video, signal })
      if (result.processing.originalSha256 !== originalHash) throw new Error('Capture changed during video processing')
      writeJsonAtomic(receipt, { originalHash, stepHash, sha256: await hashPlain(output, signal), result })
    }
    signal?.throwIfAborted()
    const bytes = readPlain(output, CAPTURE_MAX_BYTES.video)
    if (!bytes || captureProblem(bytes, 'video/mp4')) throw new Error('Processed capture video is invalid')
    return { bytes, durationMs: result.durationMs, steps: normalizeRecordingSteps(result.steps) }
  } finally { if (!pendingDir) rmSync(directory, { recursive: true, force: true }) }
}

function dropPrepared(pendingDir: string | undefined, id: string) {
  if (!pendingDir) return
  for (const name of [`${id}.json`, `${id}.processed.mp4`, `${id}.video.json`]) rmSync(join(pendingDir, name), { force: true })
}

/** A bounded header read decides whether to run the video finalizer. */
function fileType(path: string) {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch { return null }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size < 1 || info.size > CAPTURE_RAW_MAX_BYTES) return null
    const head = Buffer.alloc(64)
    return sniffCaptureType(head.subarray(0, readSync(fd, head, 0, head.length, 0)))
  } finally { closeSync(fd) }
}

/**
 * Uploads every queued capture in `dir` to `runId`. A refused file is
 * dropped; when the server cannot be reached the rest stay for next time.
 * Returns how many went up.
 */
export async function uploadCaptures(dir: string, runId: string, link: Link, log: Logger, pendingDir?: string, existingOnly = false, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted()
  if (!link.beginCapture || !link.sendCapture || !link.completeCapture) return 0
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return 0
  let sent = 0
  for (const name of readdirSync(dir).sort()) {
    signal?.throwIfAborted()
    const id = name.endsWith(".json") ? name.slice(0, -5) : ""
    if (!ID.test(id)) continue
    const meta = readPlain(join(dir, name), 128_000)
    let title = ""
    let steps: RecordingStep[] = []
    try {
      const data = JSON.parse(new TextDecoder().decode(meta ?? new Uint8Array()))
      title = cleanCaptureTitle(String(data.title ?? ""))
      steps = normalizeRecordingSteps(data.steps)
    } catch { title = '' }
    const file = EXTENSIONS.map((ext) => join(dir, `${id}.${ext}`)).find((path) => lstatSync(path, { throwIfNoEntry: false }))
    const originalType = file ? fileType(file) : null
    let video: Awaited<ReturnType<typeof prepareVideo>> | undefined
    if (file && title && originalType?.startsWith('video/')) {
      try { video = await prepareVideo(file, id, steps, pendingDir, signal) }
      catch {
        signal?.throwIfAborted()
        // Keep the original for a later retry (for example, FFmpeg was unavailable).
        // No reservation or ready capture can escape the failed finalizer.
        log.warn({ run_id: runId, capture: id }, 'capture video processing failed')
        continue
      }
    }
    signal?.throwIfAborted()
    const bytes = video?.bytes ?? (file && originalType?.startsWith('image/') ? readPlain(file, CAPTURE_MAX_BYTES.image) : null)
    const problem = !title ? "no title" : !bytes ? "no regular file" : captureProblem(bytes)
    const contentType = bytes && sniffCaptureType(bytes)
    if (problem || !bytes || !contentType) {
      log.warn({ run_id: runId, capture: id, problem }, "capture dropped")
      drop(dir, id)
      continue
    }
    try {
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const pendingPath = pendingDir ? join(pendingDir, `${id}.json`) : null
      let pending: { captureId: string; sha256: string } | undefined
      if (pendingPath) {
        try {
          const value = JSON.parse(readFileSync(pendingPath, "utf8"))
          if (typeof value.captureId === "string" && ID.test(value.captureId) && value.sha256 === sha256) pending = value
        } catch { /* absent or invalid reservation */ }
      }
      if (existingOnly && !pending) continue
      let target
      if (pending) {
        // Completion may have succeeded before the connection was lost.
        try {
          await link.completeCapture(runId, pending.captureId, signal)
          signal?.throwIfAborted()
          drop(dir, id)
          dropPrepared(pendingDir, id)
          sent += 1
          continue
        } catch (error) {
          signal?.throwIfAborted()
          if (!(error instanceof DaemonError) || error instanceof ServerUnreachableError || error.code !== 404) throw error
        }
        if (!link.resumeCapture) return sent
        try {
          target = await link.resumeCapture(runId, pending.captureId, signal)
        } catch (error) {
          signal?.throwIfAborted()
          if (existingOnly || !(error instanceof DaemonError) || error instanceof ServerUnreachableError || error.code !== 404) throw error
          target = await link.beginCapture(runId, { captureId: pending.captureId, title, contentType, size: bytes.length, sha256, ...(video ? { durationMs: video.durationMs, steps: video.steps } : {}) }, signal)
        }
      } else {
        // The stable id is durable before the network call, so a lost begin
        // response can be recovered without creating another reservation.
        if (pendingPath) {
          mkdirSync(pendingDir!, { recursive: true, mode: 0o700 })
          writeJsonAtomic(pendingPath, { captureId: id, sha256 })
        }
        target = await link.beginCapture(runId, { captureId: id, title, contentType, size: bytes.length, sha256, ...(video ? { durationMs: video.durationMs, steps: video.steps } : {}) }, signal)
        if (target.captureId !== id) throw new Error("Capture reservation id changed")
      }
      signal?.throwIfAborted()
      const { captureId, upload } = target
      await link.sendCapture(runId, captureId, upload, bytes, contentType, signal)
      signal?.throwIfAborted()
      await link.completeCapture(runId, captureId, signal)
      signal?.throwIfAborted()
      drop(dir, id)
      dropPrepared(pendingDir, id)
      sent += 1
    } catch (error) {
      // A deadline is not an authorization refusal: preserve recovery receipts
      // and stop here, before any later stage can publish after run completion.
      signal?.throwIfAborted()
      if (error instanceof ServerUnreachableError) {
        log.warn({ run_id: runId, capture: id }, "capture upload deferred")
        return sent
      }
      if (error instanceof DaemonError && (error.code === 401 || error.code === 403 || error.code === 404 || error.code === 409 || error.code === DAEMON_RPC_ERRORS.unauthorized)) {
        log.warn({ run_id: runId, capture: id, status: error.code }, "capture reservation unavailable; retry stopped")
        if (pendingDir) { mkdirSync(pendingDir, { recursive: true, mode: 0o700 }); writeJsonAtomic(join(pendingDir, "blocked.json"), { status: error.code }) }
        return sent
      }
      log.warn({ run_id: runId, capture: id, status: error instanceof DaemonError ? error.code : undefined }, "capture refused")
      drop(dir, id)
      dropPrepared(pendingDir, id)
    }
  }
  return sent
}

/** One upload pass at a time per run; a call during a pass waits for the next. */
export class CaptureUploader {
  private passes = new Map<string, { tail: Promise<void>; abort: AbortController }>()

  constructor(private readonly dirFor: (runId: string) => string, private readonly link: Link, private readonly log: Logger, private readonly pendingRoot?: string) {}

  /** A final signal bounds both this pass and any earlier pass still in flight. */
  flush(runId: string, existingOnly = false, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return Promise.resolve()
    const pendingDir = this.pendingRoot ? join(this.pendingRoot, runId) : undefined
    if (pendingDir && lstatSync(join(pendingDir, "blocked.json"), { throwIfNoEntry: false }))
      return signal ? Promise.reject(new Error('Capture upload incomplete')) : Promise.resolve()
    const pass = this.passes.get(runId) ?? { tail: Promise.resolve(), abort: new AbortController() }
    const abort = () => pass.abort.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const next = pass.tail.catch(() => undefined)
      .then(async () => {
        const dir = this.dirFor(runId)
        await uploadCaptures(dir, runId, this.link, this.log, pendingDir, existingOnly, pass.abort.signal)
        pass.abort.signal.throwIfAborted()
        if (signal && lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() && readdirSync(dir).some(name => name.endsWith('.json') && ID.test(name.slice(0, -5))))
          throw new Error('Capture upload incomplete')
      })
      .catch(error => {
        if (signal) throw error
        this.log.warn({ run_id: runId, reason: pass.abort.signal.aborted ? 'cancelled' : 'failed' }, 'capture upload failed')
      })
      .finally(() => {
        signal?.removeEventListener('abort', abort)
        if (this.passes.get(runId)?.tail === next) this.passes.delete(runId)
      })
    pass.tail = next
    this.passes.set(runId, pass)
    return next
  }
}
