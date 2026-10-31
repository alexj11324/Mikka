import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

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
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom-test-video")])
const log = pino({ level: "silent" })

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
      return { captureId: "6f1d8c0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f", upload: { target: "server" } }
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
    queue(dir, ids[1], "mp4", MP4, "Checkout flow")
    const { link, sent } = fakeLink()
    expect(await uploadCaptures(dir, "run-1", link, log)).toBe(2)
    expect(sent.map((item) => item.request)).toEqual([
      { title: "Home", contentType: "image/png", size: PNG.length, sha256: createHash("sha256").update(PNG).digest("hex") },
      { title: "Checkout flow", contentType: "video/mp4", size: MP4.length, sha256: createHash("sha256").update(MP4).digest("hex") },
    ])
    expect(readdirSync(dir)).toEqual([])
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
