// Daemon-managed harnesses: the daemon runs its own pinned Claude Code and
// Codex, never a CLI the person installed. Each is the official npm
// platform package, checked against the integrity pinned in `pins.json`
// (the registry is never trusted for it) and unpacked into
// `<root>/<harness>/<version>/bin/<command>`. Preserve the complete verified
// archive and extracted package; expose the runtime through local symlinks.
// Replaced installations and older pins remain available for inspection.
//
// Plain JavaScript with no local imports beyond the pins: the E2B templates
// run it through `cli.mjs`.
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import pins from './pins.json' with { type: 'json' }

export const MANAGED_HARNESSES = ['claude_code', 'codex']
export const HARNESS_PINS = pins

const MARKER = '.mikka-installed'
const INSTALL_FORMAT = 'complete-package-v1\n'
const installMarker = (pin, artifact) => INSTALL_FORMAT + artifact.integrity + (pin.companions?.length ? '\n' + pin.companions.join('\n') : '')
const run = promisify(execFile)
const inflight = new Map()

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

function resolvePin(store, harness) {
  const pin = (store.pins ?? HARNESS_PINS).harnesses[harness]
  return { pin, artifact: pin.platforms[store.platform ?? platformKey()] }
}

function versionDir(store, harness) {
  return join(store.root, harness, resolvePin(store, harness).pin.version)
}

/** Where the pinned binary lives once installed. */
export function harnessBinaryPath(store, harness) {
  return join(versionDir(store, harness), 'bin', resolvePin(store, harness).pin.command)
}

export function harnessInstallState(store, harness) {
  const { pin, artifact } = resolvePin(store, harness)
  if (!artifact) return { state: 'unsupported', version: pin.version }
  let installed = false
  try {
    installed = readFileSync(join(versionDir(store, harness), MARKER), 'utf8') === installMarker(pin, artifact)
      && runtimeFiles(store, harness).every(path => { const stat = statSync(path); return stat.isFile() && (stat.mode & 0o111) !== 0 })
  } catch {
    // Not installed (or a half-finished one, which is replaced).
  }
  return { state: installed ? 'installed' : 'not_installed', version: pin.version }
}

/** Codex starts its code-mode host beside the main binary. A version/integrity
 * marker from the old single-binary installer is not a usable installation. */
function runtimeFiles(store, harness) {
  const binary = harnessBinaryPath(store, harness)
  return harness === 'codex' ? [binary, join(dirname(binary), 'codex-code-mode-host')] : [binary]
}

/** The pinned binary, downloaded and verified on first need. */
export function ensureHarness(store, harness) {
  const key = `${store.root}\0${harness}`
  let pending = inflight.get(key)
  if (!pending) {
    pending = install(store, harness).finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

async function install(store, harness) {
  const binary = harnessBinaryPath(store, harness)
  const { state } = harnessInstallState(store, harness)
  if (state === 'unsupported') throw new Error(`${harness} has no build for ${store.platform ?? platformKey()}`)
  if (state === 'installed') return binary
  const { pin, artifact } = resolvePin(store, harness)
  const parent = join(store.root, harness)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const staging = join(parent, `.staging-${randomBytes(6).toString('hex')}`)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    const tarball = join(staging, 'package.tgz')
    await download(`${(store.pins ?? HARNESS_PINS).registry.replace(/\/$/, '')}/${artifact.tarball}`, tarball, artifact.integrity)
    // Extract the complete integrity-checked package, including metadata and
    // documentation. Never strip the official package to one executable.
    await run('tar', ['-xzf', tarball, '-C', staging])
    if (harness === 'codex') {
      if (!artifact.entry.endsWith('/bin/codex')) throw new Error('Invalid Codex bundle entry')
      const bundle = dirname(dirname(artifact.entry))
      // Preserve the verified platform bundle's relative layout: the code-mode
      // host, bundled search binary and other native resources live beside it.
      for (const name of readdirSync(join(staging, bundle))) symlinkSync(relative(staging, join(staging, bundle, name)), join(staging, name))
      for (const name of ['codex', 'codex-code-mode-host']) {
        const stat = statSync(join(staging, 'bin', name))
        if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('Incomplete Codex runtime bundle')
      }
    } else {
      mkdirSync(join(staging, 'bin'), { mode: 0o700 })
      symlinkSync(relative(join(staging, 'bin'), join(staging, artifact.entry)), join(staging, 'bin', pin.command))
    }
    writeFileSync(join(staging, MARKER), installMarker(pin, artifact), { mode: 0o600 })
    const target = versionDir(store, harness)
    const retained = existsSync(target) ? `${target}.retained-${randomBytes(6).toString('hex')}` : null
    if (retained) renameSync(target, retained)
    try { renameSync(staging, target) }
    catch (error) { if (retained) renameSync(retained, target); throw error }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return binary
}

async function download(url, file, integrity) {
  const [algorithm, expected] = integrity.split(/-(.*)/s)
  if (algorithm !== 'sha512' || !expected) throw new Error('Unsupported harness integrity')
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Harness download failed (${response.status})`)
  const hash = createHash('sha512')
  const tap = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(file, { mode: 0o600 }))
  if (hash.digest('base64') !== expected) throw new Error('Harness download failed its integrity check')
}

/** Pinned versions and what is installed, for the device report. */
export function managedHarnessReport(store) {
  return MANAGED_HARNESSES.map(harness => ({ harness, ...harnessInstallState(store, harness) }))
}
