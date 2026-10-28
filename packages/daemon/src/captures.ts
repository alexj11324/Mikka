// Uploads the screenshots and recordings a run's agent queued with
// `submit_capture` (agents/mikka-mcp.mjs). The run dir is the agent's to
// write, so nothing in it is trusted: no links are followed, and size, type
// and limits are checked again here and once more by the server, which binds
// the file to the run.
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { CAPTURE_MAX_BYTES, captureProblem, cleanCaptureTitle, sniffCaptureType } from "@mikka/protocol/capture"

import { DaemonError, ServerUnreachableError } from "./errors"
import type { Logger } from "./log"
import type { ServerLink } from "./server-link"

/** Name of the captures dir inside a run dir. */
export const CAPTURES_DIR = "captures"
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EXTENSIONS = ["png", "jpg", "webp", "mp4", "webm"]

type Link = Pick<ServerLink, "beginCapture" | "sendCapture" | "completeCapture">

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

/**
 * Uploads every queued capture in `dir` to `runId`. A refused file is
 * dropped; when the server cannot be reached the rest stay for next time.
 * Returns how many went up.
 */
export async function uploadCaptures(dir: string, runId: string, link: Link, log: Logger): Promise<number> {
  if (!link.beginCapture || !link.sendCapture || !link.completeCapture) return 0
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return 0
  let sent = 0
  for (const name of readdirSync(dir).sort()) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : ""
    if (!ID.test(id)) continue
    const meta = readPlain(join(dir, name), 4096)
    let title = ""
    try { title = cleanCaptureTitle(String(JSON.parse(new TextDecoder().decode(meta ?? new Uint8Array())).title ?? "")) } catch { /* dropped below */ }
    const file = EXTENSIONS.map((ext) => join(dir, `${id}.${ext}`)).find((path) => lstatSync(path, { throwIfNoEntry: false }))
    const bytes = file ? readPlain(file, CAPTURE_MAX_BYTES.video) : null
    const problem = !title ? "no title" : !bytes ? "no regular file" : captureProblem(bytes)
    const contentType = bytes && sniffCaptureType(bytes)
    if (problem || !bytes || !contentType) {
      log.warn({ run_id: runId, capture: id, problem }, "capture dropped")
      drop(dir, id)
      continue
    }
    try {
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const { captureId, upload } = await link.beginCapture(runId, { title, contentType, size: bytes.length, sha256 })
      await link.sendCapture(runId, captureId, upload, bytes, contentType)
      await link.completeCapture(runId, captureId)
      drop(dir, id)
      sent += 1
    } catch (error) {
      if (error instanceof ServerUnreachableError) {
        log.warn({ run_id: runId, capture: id }, "capture upload deferred")
        return sent
      }
      log.warn({ run_id: runId, capture: id, status: error instanceof DaemonError ? error.code : undefined }, "capture refused")
      drop(dir, id)
    }
  }
  return sent
}

/** One upload pass at a time per run; a call during a pass waits for the next. */
export class CaptureUploader {
  private passes = new Map<string, Promise<void>>()

  constructor(private readonly dirFor: (runId: string) => string, private readonly link: Link, private readonly log: Logger) {}

  flush(runId: string): Promise<void> {
    const previous = this.passes.get(runId) ?? Promise.resolve()
    const next = previous
      .then(() => uploadCaptures(this.dirFor(runId), runId, this.link, this.log))
      .then(() => undefined, (error) => this.log.warn({ run_id: runId, err: error instanceof Error ? error.message : String(error) }, "capture upload failed"))
      .finally(() => { if (this.passes.get(runId) === next) this.passes.delete(runId) })
    this.passes.set(runId, next)
    return next
  }
}
