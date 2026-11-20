import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { conflictPath, createDriveMirror, localDrivePath, type DriveCall } from "./run-drive"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const scopeId = "0f8fad5b-d9cb-469f-a165-70867728950e"
const runId = "1a2b3c4d-0000-4000-8000-000000000000"

/** An in-memory Drive folder with the server's compare-and-swap on its head digest. */
function fakeDrive() {
  const files = new Map<string, Buffer>()
  let volumeId: string | null = null
  const head = () => sha(JSON.stringify([...files.entries()].sort().map(([path, bytes]) => [path, sha(bytes)])))
  const calls: string[] = []
  const call: DriveCall = async (name, args) => {
    calls.push(name)
    if (name === "drive_list") return { isError: false, value: { volume: volumeId ? { id: volumeId, headDigest: head(),
      entries: [...files.entries()].map(([path, bytes]) => ({ path, sizeBytes: bytes.length, sha256: sha(bytes) })) } : null } }
    if (name === "drive_read") {
      const bytes = files.get(String(args.path))
      return bytes ? { isError: false, value: { content: bytes.toString("base64") } } : { isError: true, value: { error: "interop_not_found" } }
    }
    if (name === "drive_write") {
      volumeId ??= "vol_A"
      if (args.expectedDigest !== head()) return { isError: true, value: { error: "interop_drive_conflict", headDigest: head() } }
      if (args.content === undefined) files.delete(String(args.path))
      else files.set(String(args.path), Buffer.from(String(args.content), "base64"))
      return { isError: false, value: { volumeId, headDigest: head() } }
    }
    throw new Error(name)
  }
  return { files, call, calls, seed: (path: string, text: string) => { volumeId ??= "vol_A"; files.set(path, Buffer.from(text)) } }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function mirror(drive: ReturnType<typeof fakeDrive>, write = true, run = runId) {
  const root = mkdtempSync(join(tmpdir(), "run-drive-"))
  roots.push(root)
  return { root, folder: join(root, "thread", scopeId), drive: createDriveMirror({ root, runId: run, scopes: [{ scope: "thread", scopeId, write }], call: drive.call }) }
}

describe("run Drive mirror", () => {
  it("pulls the folder, pushes local changes and deletions with the head it read", async () => {
    const remote = fakeDrive()
    remote.seed("notes/plan.md", "v1")
    remote.seed("old.txt", "gone soon")
    const { folder, drive } = mirror(remote)
    await drive.pull()
    expect(readFileSync(join(folder, "notes/plan.md"), "utf8")).toBe("v1")
    writeFileSync(join(folder, "notes/plan.md"), "v2")
    writeFileSync(join(folder, "new.md"), "fresh")
    rmSync(join(folder, "old.txt"))
    await drive.push()
    expect(remote.files.get("notes/plan.md")?.toString()).toBe("v2")
    expect(remote.files.get("new.md")?.toString()).toBe("fresh")
    expect(remote.files.has("old.txt")).toBe(false)
    remote.calls.length = 0
    await drive.push()
    expect(remote.calls).toEqual([]) // nothing changed, no request
  })

  it("creates an empty scope's folder on the first write", async () => {
    const remote = fakeDrive()
    const { folder, drive } = mirror(remote)
    await drive.pull()
    writeFileSync(join(folder, "a.md"), "first")
    await drive.push()
    expect(remote.files.get("a.md")?.toString()).toBe("first")
  })

  it("a newer remote version wins the path; the local one is kept beside it", async () => {
    const remote = fakeDrive()
    remote.seed("plan.md", "base")
    const { folder, drive } = mirror(remote)
    await drive.pull()
    remote.files.set("plan.md", Buffer.from("theirs"))
    writeFileSync(join(folder, "plan.md"), "mine")
    await drive.push()
    expect(remote.files.get("plan.md")?.toString()).toBe("theirs")
    expect(remote.files.get(conflictPath("plan.md", runId))?.toString()).toBe("mine")
    expect(readFileSync(join(folder, "plan.md"), "utf8")).toBe("theirs")
    expect(readFileSync(join(folder, "plan.conflict-1a2b3c4d.md"), "utf8")).toBe("mine")
  })

  it("a concurrent change to another path is merged, not reported as a conflict", async () => {
    const remote = fakeDrive()
    remote.seed("a.md", "a")
    const { folder, drive } = mirror(remote)
    await drive.pull()
    remote.files.set("b.md", Buffer.from("someone else"))
    writeFileSync(join(folder, "a.md"), "a2")
    await drive.push()
    expect(remote.files.get("a.md")?.toString()).toBe("a2")
    expect(remote.files.get("b.md")?.toString()).toBe("someone else")
    expect([...remote.files.keys()].some(path => path.includes(".conflict-"))).toBe(false)
  })

  it("a remote deletion removes the mirrored file; a read-only folder never writes", async () => {
    const remote = fakeDrive()
    remote.seed("a.md", "a")
    const { folder, drive } = mirror(remote, false)
    await drive.pull()
    remote.files.delete("a.md")
    await drive.pull()
    expect(existsSync(join(folder, "a.md"))).toBe(false)
    writeFileSync(join(folder, "b.md"), "local only")
    remote.calls.length = 0
    await drive.push()
    expect(remote.calls).toEqual([])
  })

  it("never maps a Drive path outside its folder and never uploads a link", async () => {
    expect(localDrivePath("/x/f", "../etc/passwd")).toBeNull()
    expect(localDrivePath("/x/f", "/abs")).toBeNull()
    expect(localDrivePath("/x/f", "a/./b")).toBeNull()
    expect(localDrivePath("/x/f", "a/b.md")).toBe("/x/f/a/b.md")
    const remote = fakeDrive()
    const { folder, drive } = mirror(remote)
    await drive.pull()
    mkdirSync(join(folder, "sub"), { recursive: true })
    const { symlinkSync } = await import("node:fs")
    symlinkSync("/etc/hostname", join(folder, "sub", "link"))
    await drive.push()
    expect(remote.files.size).toBe(0)
  })
})
