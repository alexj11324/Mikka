import { mkdtempSync, rmSync } from "node:fs"
import { arch, platform, tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { HARNESS_PINS, platformKey } from "./harness-install"
import { detectHarnesses, deviceCapabilities, harnessFingerprint } from "./harnesses"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnesses-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("deviceCapabilities", () => {
  it("reports OS, arch, free disk, Docker and each managed harness's install state", async () => {
    const report = await deviceCapabilities({ root, platform: "linux-x64" }, root, async () => true)
    expect(report).toEqual({
      os: platform(),
      arch: arch(),
      freeDiskBytes: expect.any(Number),
      docker: true,
      harnesses: [
        { harness: "claude_code", state: "not_installed", version: HARNESS_PINS.harnesses.claude_code.version },
        { harness: "codex", state: "not_installed", version: HARNESS_PINS.harnesses.codex.version },
      ],
    })
    expect(report.freeDiskBytes).toBeGreaterThan(0)
    expect((await deviceCapabilities({ root }, root, async () => false)).docker).toBe(false)
  })
})

describe("detectHarnesses", () => {
  it("offers both managed harnesses without either installed", () => {
    const store = { root: join(root, "empty"), platform: platformKey() }
    const offered = detectHarnesses(store).filter(info => info.harness !== "mock")
    expect(offered).toEqual([
      { harness: "claude_code", installed: true, version: HARNESS_PINS.harnesses.claude_code.version },
      { harness: "codex", installed: true, version: HARNESS_PINS.harnesses.codex.version },
    ])
  })

  it("offers nothing on a platform with no pinned build", () => {
    const offered = detectHarnesses({ root, platform: "win32-x64" }).filter(info => info.harness !== "mock")
    expect(offered.every(info => !info.installed)).toBe(true)
  })

  it("never looks at agents on PATH", () => {
    const saved = process.env.PATH
    try {
      const before = harnessFingerprint({ root })
      process.env.PATH = "/nonexistent"
      expect(harnessFingerprint({ root })).toBe(before)
      expect(before).not.toContain("/")
    } finally {
      process.env.PATH = saved
    }
  })
})
