// Compile the hash-pinned actual core. Only relative import suffixes change.
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

const manifest = JSON.parse(readFileSync(new URL('./presence-source-hashes.json', import.meta.url), 'utf8'))
export function preparePresenceSource(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw new Error('presence_source_required')
  const sources = new Map()
  for (const [path, expected] of Object.entries(manifest.hashes)) {
    let bytes
    try { bytes = readFileSync(resolve(sourceRoot, path)) } catch { throw new Error('presence_source_missing') }
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('presence_source_mismatch')
    sources.set(path, bytes.toString('utf8'))
  }
  const device = sources.get('packages/protocol/src/device.ts'), daemon = sources.get('packages/protocol/src/daemon.ts')
  const version = /export const SOURCE_DAEMON_VERSION = '([0-9.]+)'/.exec(device)?.[1]
  const protocolVersion = Number(/export const DAEMON_PROTOCOL_VERSION = (\d+)/.exec(daemon)?.[1])
  const heartbeatWindowMs = Number(/export const DEVICE_ONLINE_WINDOW_MS = ([\d_]+)/.exec(device)?.[1]?.replaceAll('_', ''))
  if (!version || !Number.isSafeInteger(protocolVersion) || heartbeatWindowMs !== 60_000) throw new Error('presence_source_contract_invalid')
  const directory = mkdtempSync(join(tmpdir(), 'mikka-1212-presence-'))
  try {
    for (const [path, source] of sources) {
      if (!path.startsWith('lib/') || !path.endsWith('.ts')) continue
      const transformed = stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false })
        .replace(/(from\s*['"])(\.[^'"]+)(['"])/g, (_, prefix, dependency, suffix) => prefix + dependency + '.mjs' + suffix)
      if (/from\s*['"](?:[^.]|\.\.)/.test(transformed)) throw new Error('presence_source_import_invalid')
      const destination = join(directory, path.replace(/\.ts$/, '.mjs'))
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, transformed)
    }
    return { directory, sourceBase: manifest.sourceBase, hashes: manifest.hashes,
      clientPatchSha256: manifest.clientPatchSha256, version, protocolVersion, heartbeatWindowMs,
      close() { rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
