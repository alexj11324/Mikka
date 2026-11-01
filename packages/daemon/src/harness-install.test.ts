import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ensureHarness, harnessBinaryPath, harnessInstallState, HARNESS_PINS, MANAGED_HARNESSES, type HarnessPins } from "./harness-install"

let dir: string
let server: Server
let registry: string
const served: string[] = []
const tarballs = new Map<string, Buffer>()

/** An npm-style tarball holding one fake executable at `entry`. */
function fixture(name: string, entry: string, body: string) {
  const src = join(dir, `src-${name}`)
  mkdirSync(join(src, entry, ".."), { recursive: true })
  writeFileSync(join(src, entry), `#!/bin/sh\necho ${body}\n`)
  chmodSync(join(src, entry), 0o755)
  const file = join(dir, `${name}.tgz`)
  execFileSync("tar", ["-czf", file, "-C", src, entry.split("/")[0]])
  const bytes = readFileSync(file)
  tarballs.set(`/${name}.tgz`, bytes)
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}

function pins(version: string, integrity: string, tarball: string): HarnessPins {
  return {
    registry,
    harnesses: {
      claude_code: { version, command: "claude", platforms: { "test-os": { tarball, integrity, entry: "package/claude" } } },
      codex: { version: "0.0.1", command: "codex", platforms: {} },
    },
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-install-"))
  server = createServer((request, response) => {
    served.push(request.url ?? "")
    const body = tarballs.get(request.url ?? "")
    if (!body) return void response.writeHead(404).end()
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(body)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

describe("pins", () => {
  it("pin every managed harness for macOS and Linux on arm64 and x64", () => {
    for (const harness of MANAGED_HARNESSES) {
      const pin = HARNESS_PINS.harnesses[harness]
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(Object.keys(pin.platforms).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
      for (const artifact of Object.values(pin.platforms)) {
        expect(artifact.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
        expect(artifact.tarball).toContain(pin.version)
      }
    }
    expect(HARNESS_PINS.registry).toBe("https://registry.npmjs.org")
  })
})

describe("ensureHarness", () => {
  it("installs the pinned version once, into the daemon's own dir", async () => {
    const root = join(dir, "store-once")
    const store = { root, platform: "test-os", pins: pins("1.0.0", fixture("one", "package/claude", "one"), "one.tgz") }
    expect(harnessInstallState(store, "claude_code")).toEqual({ state: "not_installed", version: "1.0.0" })
    const before = served.length
    const [first, second] = await Promise.all([ensureHarness(store, "claude_code"), ensureHarness(store, "claude_code")])
    expect(first).toBe(join(root, "claude_code", "1.0.0", "bin", "claude"))
    expect(second).toBe(first)
    expect(execFileSync(first, { encoding: "utf8" }).trim()).toBe("one")
    expect(harnessInstallState(store, "claude_code").state).toBe("installed")
    await ensureHarness(store, "claude_code")
    expect(served.length - before).toBe(1)
    expect(readdirSync(join(root, "claude_code"))).toEqual(["1.0.0"])
  })

  it("replaces the old version when the pin moves", async () => {
    const root = join(dir, "store-bump")
    const old = { root, platform: "test-os", pins: pins("1.0.0", fixture("old", "package/claude", "old"), "old.tgz") }
    await ensureHarness(old, "claude_code")
    const bumped = { ...old, pins: pins("2.0.0", fixture("new", "package/claude", "new"), "new.tgz") }
    expect(harnessInstallState(bumped, "claude_code").state).toBe("not_installed")
    const binary = await ensureHarness(bumped, "claude_code")
    expect(execFileSync(binary, { encoding: "utf8" }).trim()).toBe("new")
    expect(readdirSync(join(root, "claude_code"))).toEqual(["2.0.0"])
  })

  it("refuses a tarball that does not match the pinned integrity, and leaves nothing behind", async () => {
    const root = join(dir, "store-tampered")
    fixture("tampered", "package/claude", "tampered")
    const expected = fixture("genuine", "package/claude", "genuine")
    const store = { root, platform: "test-os", pins: pins("1.0.0", expected, "tampered.tgz") }
    await expect(ensureHarness(store, "claude_code")).rejects.toThrow(/integrity/)
    expect(existsSync(harnessBinaryPath(store, "claude_code"))).toBe(false)
    expect(readdirSync(join(root, "claude_code"))).toEqual([])
  })

  it("reports a platform with no pinned build as unsupported", async () => {
    const store = { root: join(dir, "store-none"), platform: "test-os", pins: pins("1.0.0", "sha512-x", "x.tgz") }
    expect(harnessInstallState(store, "codex").state).toBe("unsupported")
    await expect(ensureHarness(store, "codex")).rejects.toThrow(/no build/)
  })
})
