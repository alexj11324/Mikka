// Daemon-managed harnesses: the daemon runs its own pinned Claude Code and
// Codex, never a CLI the person installed. Each is the official npm
// platform package, checked against the integrity pinned in
// `harness/pins.json` (the registry is never trusted for it) and unpacked
// into `<root>/<harness>/<version>/bin/<command>`. A daemon release that
// bumps a pin installs the new version on its next run and removes the old.
//
// No local imports: `harness/install.ts` runs this file with plain Node
// (type stripping) to build the E2B template from the same pins.
import { createHash, randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

import pins from "../harness/pins.json" with { type: "json" }

export type ManagedHarness = "claude_code" | "codex"
export const MANAGED_HARNESSES: readonly ManagedHarness[] = ["claude_code", "codex"]

export interface HarnessArtifact {
  /** Path under the registry, `<package>/-/<file>.tgz`. */
  tarball: string
  /** Subresource-integrity string, `sha512-<base64>`. */
  integrity: string
  /** The executable inside the tarball. */
  entry: string
}
export interface HarnessPin {
  version: string
  command: string
  platforms: Record<string, HarnessArtifact>
}
export interface HarnessPins {
  registry: string
  harnesses: Record<ManagedHarness, HarnessPin>
}
export const HARNESS_PINS: HarnessPins = pins

export interface HarnessStore {
  /** The daemon's own harness dir. */
  root: string
  pins?: HarnessPins
  /** `<platform>-<arch>`; this machine by default. */
  platform?: string
}

export type HarnessInstallState = "installed" | "not_installed" | "unsupported"

const MARKER = ".mikka-installed"
const run = promisify(execFile)
const inflight = new Map<string, Promise<string>>()

export function platformKey(platform: string = process.platform, arch: string = process.arch) {
  return `${platform}-${arch}`
}

function resolvePin(store: HarnessStore, harness: ManagedHarness) {
  const pin = (store.pins ?? HARNESS_PINS).harnesses[harness]
  const artifact = pin.platforms[store.platform ?? platformKey()]
  return { pin, artifact }
}

function versionDir(store: HarnessStore, harness: ManagedHarness) {
  return join(store.root, harness, resolvePin(store, harness).pin.version)
}

/** Where the pinned binary lives once installed. */
export function harnessBinaryPath(store: HarnessStore, harness: ManagedHarness) {
  return join(versionDir(store, harness), "bin", resolvePin(store, harness).pin.command)
}

export function harnessInstallState(store: HarnessStore, harness: ManagedHarness): { state: HarnessInstallState; version: string } {
  const { pin, artifact } = resolvePin(store, harness)
  if (!artifact) return { state: "unsupported", version: pin.version }
  const dir = versionDir(store, harness)
  let installed = false
  try {
    installed = readFileSync(join(dir, MARKER), "utf8") === artifact.integrity && statSync(harnessBinaryPath(store, harness)).isFile()
  } catch {
    // Not installed (or a half-finished one, which is replaced).
  }
  return { state: installed ? "installed" : "not_installed", version: pin.version }
}

/** The pinned binary, downloaded and verified on first need. */
export function ensureHarness(store: HarnessStore, harness: ManagedHarness): Promise<string> {
  const key = `${store.root}\0${harness}`
  let pending = inflight.get(key)
  if (!pending) {
    pending = install(store, harness).finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

async function install(store: HarnessStore, harness: ManagedHarness): Promise<string> {
  const binary = harnessBinaryPath(store, harness)
  const { state } = harnessInstallState(store, harness)
  if (state === "unsupported") throw new Error(`${harness} has no build for ${store.platform ?? platformKey()}`)
  if (state === "installed") return binary
  const { pin, artifact } = resolvePin(store, harness)
  const parent = join(store.root, harness)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const staging = join(parent, `.staging-${randomBytes(6).toString("hex")}`)
  mkdirSync(join(staging, "bin"), { recursive: true, mode: 0o700 })
  try {
    const tarball = join(staging, "package.tgz")
    const url = `${(store.pins ?? HARNESS_PINS).registry.replace(/\/$/, "")}/${artifact.tarball}`
    await download(url, tarball, artifact.integrity)
    await run("tar", ["-xzf", tarball, "-C", staging, artifact.entry])
    renameSync(join(staging, artifact.entry), join(staging, "bin", pin.command))
    rmSync(tarball)
    rmSync(join(staging, artifact.entry.split("/")[0]), { recursive: true, force: true })
    writeFileSync(join(staging, MARKER), artifact.integrity, { mode: 0o600 })
    const target = versionDir(store, harness)
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  // Older pins and interrupted downloads.
  for (const name of readdirSync(parent)) {
    if (name !== pin.version) rmSync(join(parent, name), { recursive: true, force: true })
  }
  return binary
}

async function download(url: string, file: string, integrity: string) {
  const [algorithm, expected] = integrity.split(/-(.*)/s)
  if (algorithm !== "sha512" || !expected) throw new Error("Unsupported harness integrity")
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`Harness download failed (${response.status})`)
  const hash = createHash("sha512")
  const tap = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), tap, createWriteStream(file, { mode: 0o600 }))
  if (hash.digest("base64") !== expected) throw new Error("Harness download failed its integrity check")
}

/** Pinned versions of what is installed, for the device report. */
export function managedHarnessReport(store: HarnessStore) {
  return MANAGED_HARNESSES.map(harness => ({ harness, ...harnessInstallState(store, harness) }))
}
