// Daemon-managed harnesses: the daemon runs its own pinned Claude Code and
// Codex, never a CLI the person installed. Each is the official npm
// platform package, checked against the integrity pinned in `pins.json`
// (the registry is never trusted for it) and unpacked into
// `<root>/<harness>/<version>/bin/<command>`. A daemon release that bumps a
// pin installs the new version on its next run and removes the old.
//
// Plain JavaScript with no local imports beyond the pins: the E2B templates
// run it through `cli.mjs`.
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import pins from './pins.json' with { type: 'json' }

export const MANAGED_HARNESSES = ['claude_code', 'codex']
export const HARNESS_PINS = pins

const MARKER = '.mikka-installed'
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
    installed = readFileSync(join(versionDir(store, harness), MARKER), 'utf8') === artifact.integrity
      && statSync(harnessBinaryPath(store, harness)).isFile()
  } catch {
    // Not installed (or a half-finished one, which is replaced).
  }
  return { state: installed ? 'installed' : 'not_installed', version: pin.version }
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
  mkdirSync(join(staging, 'bin'), { recursive: true, mode: 0o700 })
  try {
    const tarball = join(staging, 'package.tgz')
    await download(`${(store.pins ?? HARNESS_PINS).registry.replace(/\/$/, '')}/${artifact.tarball}`, tarball, artifact.integrity)
    await run('tar', ['-xzf', tarball, '-C', staging, artifact.entry])
    renameSync(join(staging, artifact.entry), join(staging, 'bin', pin.command))
    rmSync(tarball)
    rmSync(join(staging, artifact.entry.split('/')[0]), { recursive: true, force: true })
    writeFileSync(join(staging, MARKER), artifact.integrity, { mode: 0o600 })
    const target = versionDir(store, harness)
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  // Older pins and interrupted downloads.
  for (const name of readdirSync(parent)) if (name !== pin.version) rmSync(join(parent, name), { recursive: true, force: true })
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
