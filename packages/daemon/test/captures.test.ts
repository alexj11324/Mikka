import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"

import { MCP_SERVER_SCRIPT } from "../src/agents/run-context"
import { CaptureUploader, uploadCaptures } from "../src/captures"
import { DaemonError, ServerUnreachableError } from "../src/errors"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-test-image")])
const log = pino({ level: "silent" })
const execute = promisify(execFile)
async function video(path: string) {
  await execute('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path])
  return readFileSync(path)
}

/** Calls the run's MCP server the way a harness does, over stdio. */
async function mcp(args: string[], messages: object[]) {
  const child = spawn(process.execPath, [MCP_SERVER_SCRIPT, ...args])
  const replies = new Map<number, { result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] } }>()
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line)
    replies.set(message.id, message)
  })
  messages.forEach((message, i) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...message })}\n`))
  for (let i = 0; i < 200 && replies.size < messages.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  child.kill()
  return messages.map((_, i) => replies.get(i + 1)?.result)
}

function setup() {
  const run = tempDir("orvc-")
  const worktree = join(run, "worktree")
  const captures = join(run, "captures")
  const outside = join(run, "outside")
  for (const dir of [worktree, captures, outside]) mkdirSync(dir)
  const args = ["--handoff", join(run, "handoff.json"), "--captures", captures, "--capture-root", worktree]
  return { worktree, captures, outside, args }
}

const call = (path: string, title = "Login page") => ({ method: "tools/call", params: { name: "submit_capture", arguments: { path, title } } })

describe("submit_capture", () => {
  it("is offered only when the run has a captures dir", async () => {
    const { args } = setup()
    const [withCaptures] = await mcp(args, [{ method: "tools/list" }])
    expect(withCaptures?.tools?.map((tool) => tool.name)).toContain("submit_capture")
    const [without] = await mcp(args.slice(0, 2), [{ method: "tools/list" }])
    expect(without?.tools?.map((tool) => tool.name)).not.toContain("submit_capture")
  })

  it("queues a screenshot from the worktree with its title", async () => {
    const { worktree, captures, args } = setup()
    writeFileSync(join(worktree, "shot.png"), PNG)
    const [result] = await mcp(args, [call(join(worktree, "shot.png"), "  Login   page ")])
    expect(result?.isError).toBeUndefined()
    const files = readdirSync(captures).sort()
    expect(files).toHaveLength(2)
    const meta = files.find((name) => name.endsWith(".json"))!
    expect(JSON.parse(result!.content![0].text!)).toEqual({ captureId: meta.slice(0, -5), status: 'queued' })
    expect(JSON.parse(readFileSync(join(captures, meta), "utf8")).title).toBe("Login page")
    expect(readFileSync(join(captures, meta.replace(".json", ".png")))).toEqual(PNG)
  })

  it("refuses files outside the roots, links out of them, and files that are not media", async () => {
    const { worktree, captures, outside, args } = setup()
    writeFileSync(join(outside, "secret.png"), PNG)
    symlinkSync(join(outside, "secret.png"), join(worktree, "link.png"))
    writeFileSync(join(worktree, "page.png"), "<!doctype html><script>alert(1)</script>")
    const results = await mcp(args, [call(join(outside, "secret.png")), call(join(worktree, "link.png")), call(join(worktree, "page.png")), call(join(worktree, "missing.png")), call(join(worktree, "page.png"), " ")])
    for (const result of results) expect(result?.isError).toBe(true)
    expect(readdirSync(captures)).toEqual([])
  })
})

type Link = Parameters<typeof uploadCaptures>[2]

function fakeLink(fail?: (step: string) => Error | undefined) {
  const sent: { request: { title: string; contentType: string; size: number; sha256: string }; bytes: Uint8Array }[] = []
  const link: Link = {
    beginCapture: async (_runId, request) => {
      const error = fail?.("begin"); if (error) throw error
      sent.push({ request, bytes: new Uint8Array() })
      return { captureId: request.captureId!, upload: { target: "server" } }
    },
    sendCapture: async (_runId, _id, _upload, bytes) => { const error = fail?.("send"); if (error) throw error; sent.at(-1)!.bytes = bytes },
    completeCapture: async () => { const error = fail?.("complete"); if (error) throw error; return {} as never },
  }
  return { link, sent }
}

const queue = (dir: string, id: string, ext: string, bytes: Buffer | string, title: unknown = "Flow") => {
  writeFileSync(join(dir, `${id}.${ext}`), bytes)
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ title }))
}
const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]

describe("capture upload", () => {
  it("sends what the bytes are, with their hash, then removes the queued files", async () => {
    const dir = tempDir("orvu-")
    queue(dir, ids[0], "png", PNG, "Home")
    const recording = await video(join(dir, 'source.mp4'))
    queue(dir, ids[1], "mp4", recording, "Checkout flow")
    // The source isn't part of the queue.
    rmSync(join(dir, 'source.mp4'))
    const { link, sent } = fakeLink()
    expect(await uploadCaptures(dir, "run-1", link, log)).toBe(2)
    expect(sent[0].request).toEqual({ captureId: ids[0], title: "Home", contentType: "image/png", size: PNG.length, sha256: createHash("sha256").update(PNG).digest("hex") })
    expect(sent[1].request).toEqual({ captureId: ids[1], title: "Checkout flow", contentType: "video/mp4", size: sent[1].bytes.length,
      sha256: createHash("sha256").update(sent[1].bytes).digest("hex"), durationMs: 1000, steps: [] })
    expect(readdirSync(dir)).toEqual([])
  })

  it('retains the processed video and identical reservation digest across an upload retry', async () => {
    const dir = tempDir('capture-video-'), pending = tempDir('capture-video-pending-')
    await video(join(dir, `${ids[0]}.mp4`))
    writeFileSync(join(dir, `${ids[0]}.json`), JSON.stringify({ title: 'Observed test execution',
      steps: [{ atMs: 500, label: 'Run test', source: 'action', durationMs: 300 }] }))
    let connected = false, sentSuccessfully = false, reserved: Parameters<NonNullable<Link['beginCapture']>>[1] | undefined
    const link: Link = {
      beginCapture: async (_runId, request) => { reserved = request; return { captureId: request.captureId!, upload: { target: 'server' } } },
      resumeCapture: async (_runId, captureId) => ({ captureId, upload: { target: 'server' } }),
      sendCapture: async (_runId, _captureId, _target, bytes) => {
        if (!connected) throw new ServerUnreachableError('offline')
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(reserved!.sha256)
        sentSuccessfully = true
      },
      completeCapture: async () => { if (!sentSuccessfully) throw new DaemonError(404, 'not sent'); return {} as never },
    }
    expect(await uploadCaptures(dir, 'run-1', link, log, pending)).toBe(0)
    expect(readdirSync(pending).sort()).toEqual([`${ids[0]}.json`, `${ids[0]}.processed.mp4`, `${ids[0]}.video.json`])
    expect(reserved).toMatchObject({ captureId: ids[0], durationMs: 1000, steps: [{ atMs: 500, source: 'action', durationMs: 300 }] })
    connected = true
    expect(await uploadCaptures(dir, 'run-1', link, log, pending, true)).toBe(1)
    expect(sentSuccessfully).toBe(true)
    expect(readdirSync(dir)).toEqual([]); expect(readdirSync(pending)).toEqual([])
  })

  it('never reserves a malformed video whose MP4 header alone looks valid', async () => {
    const dir = tempDir('capture-invalid-video-')
    queue(dir, ids[0], 'mp4', Buffer.from('\x00\x00\x00\x18ftypisom-not-a-video'))
    const { link, sent } = fakeLink()
    expect(await uploadCaptures(dir, 'run-1', link, log)).toBe(0)
    expect(sent).toEqual([])
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it("drops what the agent planted: wrong bytes, a link, no title", async () => {
    const dir = tempDir("orvu-")
    const elsewhere = tempDir("orvx-")
    writeFileSync(join(elsewhere, "secret.png"), PNG)
    queue(dir, ids[0], "png", "<html>not an image</html>")
    symlinkSync(join(elsewhere, "secret.png"), join(dir, `${ids[1]}.png`))
    writeFileSync(join(dir, `${ids[1]}.json`), JSON.stringify({ title: "Linked" }))
    queue(dir, ids[2], "png", PNG, "")
    const { link, sent } = fakeLink()
    expect(await uploadCaptures(dir, "run-1", link, log)).toBe(0)
    expect(sent).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(elsewhere, "secret.png"))).toBe(true)
  })

  it("keeps files while the server is unreachable and drops ones it refuses", async () => {
    const dir = tempDir("orvu-")
    queue(dir, ids[0], "png", PNG)
    const offline = fakeLink(() => new ServerUnreachableError("down"))
    expect(await uploadCaptures(dir, "run-1", offline.link, log)).toBe(0)
    expect(readdirSync(dir)).toHaveLength(2)
    const refused = fakeLink((step) => (step === "complete" ? new DaemonError(400, "invalid") : undefined))
    expect(await uploadCaptures(dir, "run-1", refused.link, log)).toBe(0)
    expect(readdirSync(dir)).toEqual([])
  })

  it("persists a reservation and resumes it after a restart without beginning a new upload", async () => {
    const dir = tempDir("capture-queue-")
    const pending = tempDir("capture-pending-")
    queue(dir, ids[0], "png", PNG)
    let begins = 0, sends = 0, completes = 0, resumes = 0
    const captureId = ids[0]
    const link: Link = {
      beginCapture: async () => { begins++; return { captureId, upload: { target: "server" } } },
      resumeCapture: async () => { resumes++; return { captureId, upload: { target: "server" } } },
      sendCapture: async () => { sends++; if (sends === 1) throw new ServerUnreachableError() },
      completeCapture: async () => { completes++; if (completes === 1) throw new DaemonError(404, "not arrived"); return {} as never },
    }
    expect(await uploadCaptures(dir, "run-1", link, log, pending)).toBe(0)
    expect(readdirSync(pending)).toEqual([`${ids[0]}.json`])
    expect(await uploadCaptures(dir, "run-1", link, log, pending, true)).toBe(1)
    expect({ begins, sends, completes, resumes }).toEqual({ begins: 1, sends: 2, completes: 2, resumes: 1 })
    expect(readdirSync(dir)).toEqual([])
    expect(readdirSync(pending)).toEqual([])
  })

  it("recovers a lost begin response using the id saved before the request", async () => {
    const dir = tempDir("capture-queue-")
    const pending = tempDir("capture-pending-")
    queue(dir, ids[0], "png", PNG)
    let begins = 0, resumed = "", sends = 0
    const link: Link = {
      beginCapture: async (_run, request) => { begins++; expect(request.captureId).toBe(ids[0]); throw new ServerUnreachableError() },
      resumeCapture: async (_run, captureId) => { resumed = captureId; return { captureId, upload: { target: "server" } } },
      sendCapture: async () => { sends++ },
      completeCapture: async () => { if (!sends) throw new DaemonError(404, "not arrived"); return {} as never },
    }
    expect(await uploadCaptures(dir, "run-1", link, log, pending)).toBe(0)
    expect(await uploadCaptures(dir, "run-1", link, log, pending, true)).toBe(1)
    expect({ begins, resumed, sends }).toEqual({ begins: 1, resumed: ids[0], sends: 1 })
  })

  it("does not create a new reservation after the run ends", async () => {
    const dir = tempDir("capture-queue-")
    const pending = tempDir("capture-pending-")
    queue(dir, ids[0], "png", PNG)
    const { link, sent } = fakeLink()
    expect(await uploadCaptures(dir, "run-1", link, log, pending, true)).toBe(0)
    expect(sent).toEqual([])
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it("recognizes a completion whose response was lost without uploading again", async () => {
    const dir = tempDir("capture-queue-")
    const pending = tempDir("capture-pending-")
    queue(dir, ids[0], "png", PNG)
    let sends = 0, completes = 0
    const link: Link = {
      beginCapture: async () => ({ captureId: ids[0], upload: { target: "server" } }),
      resumeCapture: async () => { throw new Error("must not resume a completed upload") },
      sendCapture: async () => { sends++ },
      completeCapture: async () => { completes++; if (completes === 1) throw new ServerUnreachableError(); return {} as never },
    }
    expect(await uploadCaptures(dir, "run-1", link, log, pending)).toBe(0)
    expect(await uploadCaptures(dir, "run-1", link, log, pending, true)).toBe(1)
    expect(sends).toBe(1)
    expect(completes).toBe(2)
  })

  it("does not duplicate an upload still running when terminal retry starts", async () => {
    const dir = tempDir("capture-queue-")
    const pending = tempDir("capture-pending-")
    queue(dir, ids[0], "png", PNG)
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let begins = 0, sends = 0, completes = 0
    const link: Link = {
      beginCapture: async () => { begins++; return { captureId: ids[0], upload: { target: "server" } } },
      sendCapture: async () => { sends++; started(); await gate },
      completeCapture: async () => { completes++; return {} as never },
    }
    const uploader = new CaptureUploader(() => dir, link, log, pending)
    const first = uploader.flush("run-1")
    await startedPromise
    const afterEnd = uploader.flush("run-1", true)
    release()
    await Promise.all([first, afterEnd])
    expect({ begins, sends, completes }).toEqual({ begins: 1, sends: 1, completes: 1 })
    expect(readdirSync(dir)).toEqual([])
  })

  it('cancels an existing background upload and drains it before the final flush fails', async () => {
    const dir = tempDir('capture-deadline-'), pending = tempDir('capture-deadline-pending-')
    queue(dir, ids[0], 'png', PNG)
    let release!: () => void, entered!: () => void, uploadSignal: AbortSignal | undefined
    const uploading = new Promise<void>(resolve => { entered = resolve })
    const cleanup = new Promise<void>(resolve => { release = resolve })
    let completes = 0
    const link: Link = {
      beginCapture: async () => ({ captureId: ids[0], upload: { target: 'server' } }),
      sendCapture: async (_runId, _captureId, _upload, _bytes, _contentType, signal) => {
        uploadSignal = signal
        entered()
        // Even a transport that takes time to unwind cannot publish afterward.
        await cleanup
      },
      completeCapture: async () => { completes++; return {} as never },
    }
    const uploader = new CaptureUploader(() => dir, link, log, pending)
    const background = uploader.flush('run-1')
    await uploading
    const deadline = new AbortController(), reason = new Error('Capture finalization deadline exceeded')
    let finalSettled = false
    const final = uploader.flush('run-1', false, deadline.signal)
      .then(() => ({ error: undefined }), error => ({ error }))
      .finally(() => { finalSettled = true })
    try {
      deadline.abort(reason)
      expect(uploadSignal?.aborted).toBe(true)
      await Promise.resolve()
      expect(finalSettled).toBe(false)
      release()
      expect(await final).toEqual({ error: reason })
      await background
      expect(completes).toBe(0)
      expect(readdirSync(dir)).toHaveLength(2)
      expect(existsSync(join(pending, 'run-1', 'blocked.json'))).toBe(false)
    } finally { release(); await Promise.all([background, final]) }
  })

  it('reports an incomplete final flush when the server cannot accept the evidence', async () => {
    const dir = tempDir('capture-final-failure-'), pending = tempDir('capture-final-failure-pending-')
    queue(dir, ids[0], 'png', PNG)
    const { link } = fakeLink(() => new ServerUnreachableError('offline'))
    const uploader = new CaptureUploader(() => dir, link, log, pending)
    await expect(uploader.flush('run-1', false, new AbortController().signal)).rejects.toThrow('Capture upload incomplete')
    expect(readdirSync(dir)).toHaveLength(2)
    expect(existsSync(join(pending, 'run-1', 'blocked.json'))).toBe(false)
  })

  it('cancels real oversized-video preparation before it can reserve an upload after the final deadline', async () => {
    const dir = tempDir('capture-prepare-deadline-'), pending = tempDir('capture-prepare-deadline-pending-')
    const source = join(dir, `${ids[0]}.mp4`)
    const original = await video(source)
    // A valid sparse free atom makes preparation long enough to observe without
    // replacing FFmpeg or the file pipeline with a mock.
    const atomSize = 200_000_001, header = Buffer.alloc(8)
    header.writeUInt32BE(atomSize); header.write('free', 4)
    appendFileSync(source, header)
    truncateSync(source, original.length + atomSize)
    writeFileSync(join(dir, `${ids[0]}.json`), JSON.stringify({ title: 'Recorded execution' }))
    const { link, sent } = fakeLink()
    const uploader = new CaptureUploader(() => dir, link, log, pending)
    const background = uploader.flush('run-1'), pendingDir = join(pending, 'run-1')
    const deadline = new AbortController(), reason = new Error('Capture finalization deadline exceeded')
    try {
      await waitFor(() => existsSync(pendingDir) && readdirSync(pendingDir).some(name => name.startsWith('.capture-process-')), 15_000, 1)
      const final = uploader.flush('run-1', false, deadline.signal)
      const rejected = expect(final).rejects.toBe(reason)
      deadline.abort(reason)
      await rejected
      await background
      expect(sent).toEqual([])
      expect(existsSync(source)).toBe(true)
      expect(readdirSync(pendingDir)).toEqual([])
    } finally { deadline.abort(reason); await background }
  })

  it("retains the file and stops retries when authorization is denied", async () => {
    const dir = tempDir("capture-queue-")
    const pending = tempDir("capture-pending-")
    queue(dir, ids[0], "png", PNG)
    let attempts = 0
    const link: Link = {
      beginCapture: async () => { attempts++; throw new DaemonError(403, "denied") },
      sendCapture: async () => undefined,
      completeCapture: async () => ({} as never),
    }
    const uploader = new CaptureUploader(() => dir, link, log, pending)
    await uploader.flush("run-1")
    await uploader.flush("run-1", true)
    expect(attempts).toBe(1)
    expect(readdirSync(dir)).toHaveLength(2)
    expect(readdirSync(join(pending, "run-1")).sort()).toEqual([`${ids[0]}.json`, "blocked.json"])
  })

  it("runs one pass at a time per run", async () => {
    const dir = tempDir("orvu-")
    queue(dir, ids[0], "png", PNG)
    const { link, sent } = fakeLink()
    const uploader = new CaptureUploader(() => dir, link, log)
    await Promise.all([uploader.flush("run-1"), uploader.flush("run-1")])
    expect(sent).toHaveLength(1)
  })
})

describe("a run's captures", () => {
  it("go up to that run before it reports its end", async () => {
    const repo = await makeRepo()
    const server = new MemoryServer("device-1")
    server.addRepo("device-1", { repoId: "repo-1", name: "sandbox", path: repo })
    const runId = server.queueRun("device-1", { issueId: "issue-1", repoId: "repo-1", baseBranch: "main", harness: "mock", prompt: "do it", fixture: "success-edit" })
    const dataDir = tempDir()
    const dir = join(dataDir, "adapters", "runs", runId, "captures")
    mkdirSync(dir, { recursive: true })
    queue(dir, ids[0], "png", PNG, "Evidence")
    const uploads: { runId: string; title: string; completedBeforeEnd: boolean }[] = []
    const base = server.link()
    const link = {
      ...base,
      beginCapture: async (id: string, request: { title: string; captureId?: string }) => {
        uploads.push({ runId: id, title: request.title, completedBeforeEnd: false })
        return { captureId: request.captureId!, upload: { target: "server" as const } }
      },
      sendCapture: async () => undefined,
      completeCapture: async () => {
        uploads.at(-1)!.completedBeforeEnd = !server.runs.get(runId)?.completion
        return {} as never
      },
    }
    const daemon = await new Daemon({ dataDir, flavor: "dev", agentSandbox: null, link, credential: "cred-1", harnesses: [{ harness: "mock", installed: true, version: "test" }], mockSpeed: Number.POSITIVE_INFINITY, heartbeatMs: 50, quotaSource: null }).start()
    daemons.push(daemon)
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find((run) => run.runId === runId))
    await daemon.supervisor.idle()
    expect(uploads).toEqual([{ runId, title: "Evidence", completedBeforeEnd: true }])
    expect(readdirSync(dir)).toEqual([])
  })
})
