// The Linux sandbox needs bwrap, socat and rg, which npm cannot install. None
// of them needs root to run, so a missing tool is fetched from the machine's
// own signed apt sources and kept in the daemon's data directory. Never sudo:
// a background service must not change the system.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { execa } from "execa"

import { appendToPath, findOnPath } from "./path-search"

const TOOLS = [
  { command: "bwrap", package: "bubblewrap", versionFlag: "--version" },
  { command: "socat", package: "socat", versionFlag: "-V" },
  { command: "rg", package: "ripgrep", versionFlag: "--version" },
] as const

const APT_TIMEOUT_MS = 120_000
const TOOL_CHECK_TIMEOUT_MS = 5_000

export type ToolRunner = (file: string, args: string[], cwd?: string, env?: Record<string, string>) => Promise<{ stdout?: string } | void>

interface ToolsLog {
  info(data: object, message: string): void
  warn(data: object, message: string): void
}

const runTool: ToolRunner = async (file, args, cwd, env) => {
  const { stdout } = await execa(file, args, { cwd, env, stdin: "ignore", timeout: file === "apt-get" ? APT_TIMEOUT_MS : TOOL_CHECK_TIMEOUT_MS })
  return { stdout: String(stdout) }
}

export function sandboxToolsDir(dataDir: string) {
  return join(dataDir, "sandbox-tools", "bin")
}

/** Packages whose command is not on PATH. */
export function missingSandboxTools(): string[] {
  return TOOLS.filter(tool => !findOnPath(tool.command)).map(tool => tool.package)
}

/** Make the tools available without root; returns the packages still missing. Never throws. */
export async function ensureSandboxTools(options: {
  dataDir: string
  log: ToolsLog
  run?: ToolRunner
  platform?: NodeJS.Platform
}): Promise<string[]> {
  if ((options.platform ?? process.platform) !== "linux") return []
  const { dataDir, log, run = runTool } = options
  const binDir = sandboxToolsDir(dataDir)
  appendToPath([binDir])
  const needed = TOOLS.filter(tool => !findOnPath(tool.command))
  if (needed.length === 0) return []
  const packages = needed.map(tool => tool.package)
  if (!findOnPath("apt-get") || !findOnPath("dpkg-deb")) {
    log.warn({ missing: packages }, "sandbox tools missing and apt is unavailable")
    return packages
  }
  mkdirSync(binDir, { recursive: true, mode: 0o700 })
  // Not the system temp directory: /tmp is often mounted noexec, and the tools
  // are executed here to check they run before they are kept.
  const work = mkdtempSync(join(dataDir, "sandbox-tools", ".install-"))
  try {
    const apt = await downloadPackages(work, packages, run)
    for (const tool of needed) {
      try {
        await installTool(tool, { work, dataDir, apt, run })
      } catch (err) {
        log.warn({ package: tool.package, err: errorMessage(err) }, "sandbox tool unusable on this machine")
      }
    }
  } catch (err) {
    log.warn({ missing: packages, err: errorMessage(err) }, "could not download sandbox tools")
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  const missing = missingSandboxTools()
  if (missing.length < packages.length) log.info({ installed: packages.filter(name => !missing.includes(name)) }, "sandbox tools installed")
  return missing
}

/** Keep the tool if it runs as is; a minimal image may lack its libraries, so bring those too. */
async function installTool(tool: (typeof TOOLS)[number], context: { work: string; dataDir: string; apt: string[]; run: ToolRunner }) {
  const { work, dataDir, apt, run } = context
  const root = join(work, "root")
  await run("dpkg-deb", ["-x", join(work, debFile(work, tool.package)), root], work)
  const unpacked = join(root, "usr", "bin", tool.command)
  chmodSync(unpacked, 0o755)
  const binDir = sandboxToolsDir(dataDir)
  try {
    await run(unpacked, [tool.versionFlag], work)
    renameSync(unpacked, join(binDir, tool.command))
    return
  } catch {
    // Most likely missing shared libraries; the check below is what decides.
  }
  const plan = await run("apt-get", ["-s", "-qq", ...apt, "install", tool.package], work)
  const dependencies = [...String(plan?.stdout ?? "").matchAll(/^Inst (\S+)/gm)].map(match => match[1]!).filter(name => name !== tool.package)
  if (dependencies.length === 0) throw new Error("the tool does not run and has no missing dependencies")
  await run("apt-get", ["-qq", ...apt, "download", ...dependencies], work)
  for (const dependency of dependencies) await run("dpkg-deb", ["-x", join(work, debFile(work, dependency)), root], work)
  const libDir = join(dataDir, "sandbox-tools", "lib")
  mkdirSync(libDir, { recursive: true, mode: 0o700 })
  for (const directory of [join(root, "lib"), join(root, "usr", "lib")]) moveSharedLibraries(directory, libDir)
  await run(unpacked, [tool.versionFlag], work, { LD_LIBRARY_PATH: libDir })
  // Only this command sees the private libraries, never the rest of the daemon.
  const realDir = join(dataDir, "sandbox-tools", "libexec")
  mkdirSync(realDir, { recursive: true, mode: 0o700 })
  renameSync(unpacked, join(realDir, tool.command))
  const launcher = join(work, `${tool.command}.launcher`)
  writeFileSync(launcher, `#!/bin/sh\nLD_LIBRARY_PATH=${shellQuote(libDir)} exec ${shellQuote(join(realDir, tool.command))} "$@"\n`, { mode: 0o755 })
  renameSync(launcher, join(binDir, tool.command))
}

function moveSharedLibraries(directory: string, libDir: string) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (lstatSync(path).isDirectory()) moveSharedLibraries(path, libDir)
    else if (entry.includes(".so") && !existsSync(join(libDir, entry))) renameSync(path, join(libDir, entry))
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Try the system's package lists; fresh images have none, so fall back to private ones. Returns the apt options that worked. */
async function downloadPackages(work: string, packages: string[], run: ToolRunner): Promise<string[]> {
  const cache = join(work, "cache")
  mkdirSync(join(cache, "archives", "partial"), { recursive: true })
  const unprivileged = ["-o", `Dir::Cache=${cache}`, "-o", "Debug::NoLocking=1", "-o", "APT::Sandbox::User="]
  try {
    await run("apt-get", ["-qq", ...unprivileged, "download", ...packages], work)
    return unprivileged
  } catch {
    const lists = join(work, "lists")
    mkdirSync(join(lists, "partial"), { recursive: true })
    const privateLists = [...unprivileged, "-o", `Dir::State::lists=${lists}`]
    await run("apt-get", ["-qq", ...privateLists, "update"], work)
    await run("apt-get", ["-qq", ...privateLists, "download", ...packages], work)
    return privateLists
  }
}

function debFile(work: string, name: string) {
  const file = readdirSync(work).find(entry => entry === `${name}.deb` || entry.startsWith(`${name}_`))
  if (!file) throw new Error(`${name} package was not downloaded`)
  return file
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message.slice(0, 300) : "unknown error"
}
