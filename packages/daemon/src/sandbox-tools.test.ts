import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { findOnPath } from "./path-search"
import { ensureSandboxTools, missingSandboxTools, sandboxToolsDir, type ToolRunner } from "./sandbox-tools"

const log = { info() {}, warn() {} }
let root: string
let systemBin: string
let savedPath: string | undefined

function executable(path: string, body = "#!/bin/sh\nexit 0\n") {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

/** A rootless apt: `download` writes one marker per package, `dpkg -x` unpacks them. */
function fakeApt(options: { failFirstDownload?: boolean; withoutBinary?: string; failUpdate?: boolean } = {}) {
  const calls: string[] = []
  let downloads = 0
  const run: ToolRunner = async (file, args, cwd) => {
    calls.push([file, ...args.filter(arg => !arg.startsWith("-") && !arg.includes("::"))].join(" "))
    if (args.includes("update")) {
      if (options.failUpdate) throw new Error("no network")
      return
    }
    if (args.includes("download")) {
      downloads++
      if (options.failFirstDownload && downloads === 1) throw new Error("no candidate")
      for (const name of args.slice(args.indexOf("download") + 1)) writeFileSync(join(cwd!, `${name}.deb`), name)
      return
    }
    if (file === "dpkg-deb") {
      const name = args[1]!.split("/").pop()!.replace(".deb", "")
      const command = name === "bubblewrap" ? "bwrap" : name === "ripgrep" ? "rg" : name
      if (command === options.withoutBinary) return
      mkdirSync(join(args[2]!, "usr/bin"), { recursive: true })
      executable(join(args[2]!, "usr/bin", command))
    }
  }
  return { calls, run }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sandbox-tools-"))
  systemBin = join(root, "system")
  mkdirSync(systemBin)
  for (const tool of ["apt-get", "dpkg-deb"]) executable(join(systemBin, tool))
  savedPath = process.env.PATH
  process.env.PATH = systemBin
})

afterEach(() => {
  process.env.PATH = savedPath
  rmSync(root, { recursive: true, force: true })
})

describe("ensureSandboxTools", () => {
  it("does nothing outside Linux", async () => {
    const { calls, run } = fakeApt()
    expect(await ensureSandboxTools({ dataDir: root, log, run, platform: "darwin" })).toEqual([])
    expect(calls).toEqual([])
  })

  it("leaves a machine that already has every tool untouched", async () => {
    for (const tool of ["bwrap", "socat", "rg"]) executable(join(systemBin, tool))
    const { calls, run } = fakeApt()
    expect(await ensureSandboxTools({ dataDir: root, log, run, platform: "linux" })).toEqual([])
    expect(calls).toEqual([])
  })

  it("installs only the missing tools into the data directory, without root", async () => {
    executable(join(systemBin, "bwrap"))
    const { calls, run } = fakeApt()
    expect(await ensureSandboxTools({ dataDir: root, log, run, platform: "linux" })).toEqual([])
    expect(calls.join("\n")).not.toContain("sudo")
    expect(calls[0]).toBe("apt-get download socat ripgrep")
    expect(readdirSync(sandboxToolsDir(root)).sort()).toEqual(["rg", "socat"])
    expect(findOnPath("socat")).toBe(join(sandboxToolsDir(root), "socat"))
    // Temporary downloads never remain beside the installed tools.
    expect(readdirSync(join(root, "sandbox-tools"))).toEqual(["bin"])
  })

  it("keeps a system tool ahead of the private copy", async () => {
    await ensureSandboxTools({ dataDir: root, log, run: fakeApt().run, platform: "linux" })
    expect(process.env.PATH!.split(delimiter)[0]).toBe(systemBin)
  })

  it("refreshes private package lists when the system lists have no candidate", async () => {
    const { calls, run } = fakeApt({ failFirstDownload: true })
    expect(await ensureSandboxTools({ dataDir: root, log, run, platform: "linux" })).toEqual([])
    expect(calls.map(call => call.split(" ")[1])).toEqual(expect.arrayContaining(["download", "update"]))
  })

  it("reuses the tools installed by an earlier start without touching apt", async () => {
    await ensureSandboxTools({ dataDir: root, log, run: fakeApt().run, platform: "linux" })
    process.env.PATH = systemBin
    const second = fakeApt()
    expect(await ensureSandboxTools({ dataDir: root, log, run: second.run, platform: "linux" })).toEqual([])
    expect(second.calls).toEqual([])
  })

  it("reports what is still missing when the package manager fails, and never throws", async () => {
    const run: ToolRunner = async () => { throw new Error("no network") }
    expect(await ensureSandboxTools({ dataDir: root, log, run, platform: "linux" })).toEqual(["bubblewrap", "socat", "ripgrep"])
    expect(readdirSync(join(root, "sandbox-tools"))).toEqual(["bin"])
  })

  it("brings the libraries a minimal image lacks and scopes them to that command", async () => {
    const { run } = fakeApt()
    const seen: (Record<string, string> | undefined)[] = []
    const needsLibrary: ToolRunner = async (file, args, cwd, env) => {
      if (file.endsWith("/socat")) {
        seen.push(env)
        if (!env?.LD_LIBRARY_PATH) throw new Error("libwrap.so.0: cannot open shared object file")
        return
      }
      if (args.includes("-s")) return { stdout: "Inst libwrap0 (7.6 Debian)\nConf libwrap0\nInst socat (1.7 Debian)\n" }
      if (file === "dpkg-deb" && args[1]!.endsWith("libwrap0.deb")) {
        mkdirSync(join(args[2]!, "lib/aarch64-linux-gnu"), { recursive: true })
        writeFileSync(join(args[2]!, "lib/aarch64-linux-gnu/libwrap.so.0"), "library")
        return
      }
      return run(file, args, cwd)
    }
    expect(await ensureSandboxTools({ dataDir: root, log, run: needsLibrary, platform: "linux" })).toEqual([])
    const libDir = join(root, "sandbox-tools/lib")
    expect(readdirSync(libDir)).toEqual(["libwrap.so.0"])
    expect(seen.at(-1)).toEqual({ LD_LIBRARY_PATH: libDir })
    const launcher = readFileSync(join(sandboxToolsDir(root), "socat"), "utf8")
    expect(launcher).toContain(`LD_LIBRARY_PATH='${libDir}' exec '${join(root, "sandbox-tools/libexec/socat")}' "$@"`)
    expect(process.env.LD_LIBRARY_PATH).toBeUndefined()
  })

  it("does not install a tool that still cannot run", async () => {
    const { run } = fakeApt()
    const validating: ToolRunner = async (file, args, cwd) => {
      if (file.endsWith("/socat")) throw new Error("wrong architecture")
      if (args.includes("-s")) return { stdout: "Inst socat (1.7 Debian)\n" }
      return run(file, args, cwd)
    }
    expect(await ensureSandboxTools({ dataDir: root, log, run: validating, platform: "linux" })).toEqual(["socat"])
    expect(readdirSync(sandboxToolsDir(root)).sort()).toEqual(["bwrap", "rg"])
  })

  it("reports machines without apt rather than guessing", async () => {
    rmSync(join(systemBin, "apt-get"))
    const { calls, run } = fakeApt()
    expect(await ensureSandboxTools({ dataDir: root, log, run, platform: "linux" })).toEqual(["bubblewrap", "socat", "ripgrep"])
    expect(calls).toEqual([])
  })
})

describe("missingSandboxTools", () => {
  it("names packages, the words a person installs", () => {
    executable(join(systemBin, "socat"))
    expect(missingSandboxTools()).toEqual(["bubblewrap", "ripgrep"])
  })
})
