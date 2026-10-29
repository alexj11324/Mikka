import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { browseFolder, verifyExpectedOrigin } from "../src/fs-browse"

describe("browseFolder", () => {
  const root = mkdtempSync(join(tmpdir(), "mikka-fs-"))
  const repo = join(root, "app")
  mkdirSync(join(repo, "src"), { recursive: true })
  mkdirSync(join(root, "plain"))
  mkdirSync(join(root, ".hidden"))
  writeFileSync(join(root, "file.txt"), "x")
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "git@github.com:o/app.git",
  ])

  it("lists folders only, repos marked, hidden left out", async () => {
    const result = await browseFolder({ path: root })
    expect(result).toMatchObject({
      ok: true,
      path: root,
      truncated: false,
      repo: null,
    })
    if (!result.ok) return
    expect(result.entries.map((e) => [e.name, e.isRepo])).toEqual([
      ["app", true],
      ["plain", false],
    ])
    const hidden = await browseFolder({ path: root, showHidden: true })
    expect(hidden.ok && hidden.entries.map((e) => e.name)).toContain(".hidden")
  })

  it("names the repo around a subfolder with its remote", async () => {
    const result = await browseFolder({ path: join(repo, "src") })
    expect(result).toMatchObject({
      ok: true,
      repo: { remoteUrl: "git@github.com:o/app.git" },
    })
    expect(result.ok && result.repo?.path).toMatch(/app$/)
  })


  it("checks the exact checkout and GitHub origin against the asserted remote", async () => {
    expect(await verifyExpectedOrigin(repo, "https://github.com/o/app")).toBe(true)
    expect(await verifyExpectedOrigin(repo, "https://github.com/o/other")).toBe(false)
    expect(await verifyExpectedOrigin(join(repo, "src"), "https://github.com/o/app")).toBe(false)
    expect(await verifyExpectedOrigin(repo, "https://user:secret@github.com/o/app")).toBe(false)
    expect(await verifyExpectedOrigin(join(root, "plain"), "https://github.com/o/app")).toBe(false)
  })

  it("answers missing paths, files and relative paths", async () => {
    expect(await browseFolder({ path: join(root, "nope") })).toMatchObject({
      ok: false,
      code: "not_found",
    })
    expect(await browseFolder({ path: join(root, "file.txt") })).toMatchObject({
      ok: false,
      code: "not_a_directory",
    })
    expect(await browseFolder({ path: "relative/dir" })).toMatchObject({
      ok: false,
      code: "not_found",
    })
  })

  it("starts at home without a path", async () => {
    const result = await browseFolder({})
    expect(result.ok && result.path).toBe(result.ok && result.home)
  })
})
