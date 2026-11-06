// The exact deployed old core and DevicesSettings provenance, not new-code fallback.
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
const manifest = JSON.parse(readFileSync(new URL('./presence-baseline-source-hashes.json', import.meta.url), 'utf8'))
export function prepareBaselineSource(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw new Error('presence_baseline_source_required')
  const sources = new Map()
  for (const [path, expected] of Object.entries(manifest.hashes)) {
    const bytes = readFileSync(resolve(sourceRoot, path))
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('presence_baseline_source_mismatch')
    sources.set(path, bytes.toString('utf8'))
  }
  const directory = mkdtempSync(join(tmpdir(), 'mikka-1212-before-'))
  try {
    for (const path of manifest.runtime) {
      const transformed = stripTypeScriptTypes(sources.get(path), { mode: 'transform', sourceMap: false })
        .replace(/(from\s*['"])(\.[^'"]+)(['"])/g, (_, prefix, dependency, suffix) => prefix + dependency + '.mjs' + suffix)
      if (/from\s*['"](?:[^.]|\.\.)/.test(transformed)) throw new Error('presence_baseline_import_invalid')
      const destination = join(directory, path.replace(/\.ts$/, '.mjs'))
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, transformed)
    }
    return { directory, sourceBase: manifest.sourceBase, hashes: manifest.hashes, clientPatchSha256: null,
      version: /export const SOURCE_DAEMON_VERSION = '([0-9.]+)'/.exec(sources.get('packages/protocol/src/device.ts'))?.[1],
      protocolVersion: Number(/export const DAEMON_PROTOCOL_VERSION = (\d+)/.exec(sources.get('packages/protocol/src/daemon.ts'))?.[1]),
      heartbeatWindowMs: Number(/export const DEVICE_ONLINE_WINDOW_MS = ([\d_]+)/.exec(sources.get('packages/protocol/src/device.ts'))?.[1]?.replaceAll('_', '')),
      close() { rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
