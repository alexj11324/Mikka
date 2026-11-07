// Exact reviewed source only. The client proof holder and payload parser are
// product code, transformed by Node 24 with relative import suffixes adjusted.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const manifest = JSON.parse(readFileSync(new URL('./source-hashes.json', import.meta.url), 'utf8'))
const compiled = [
  'apps/mobile/lib/presence-scope.ts', 'apps/mobile/lib/api-cache.ts',
  'lib/live/events.ts', 'lib/live/presence.ts', 'lib/live/home-scope-proof.ts',
  'lib/live/scope.ts', 'lib/device-gateway-ticket.ts', 'lib/device-presence-grant.ts',
]
const fail = (code, cause) => { throw Object.assign(new Error(code, cause ? { cause } : undefined), { code }) }

export async function prepareMobilePresenceSource(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) fail('presence_mobile_source_required')
  const sources = new Map()
  for (const [path, hash] of Object.entries(manifest.hashes)) {
    let bytes
    try { bytes = readFileSync(resolve(sourceRoot, path)) } catch (cause) { fail('presence_mobile_source_missing', cause) }
    if (createHash('sha256').update(bytes).digest('hex') !== hash) fail('presence_mobile_source_mismatch')
    sources.set(path, bytes.toString('utf8'))
  }
  let identity
  try { identity = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD', 'HEAD^{tree}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim().split('\n') }
  catch (cause) { fail('presence_mobile_source_head_invalid', cause) }
  if (identity[0] !== manifest.sourceCommit || identity[1] !== manifest.sourceTree) fail('presence_mobile_source_head_mismatch')
  const directory = mkdtempSync(join(tmpdir(), 'mikka-mobile-presence-'))
  try {
    for (const path of compiled) {
      const transformed = stripTypeScriptTypes(sources.get(path), { mode: 'transform', sourceMap: false })
        .replace(/(from\s*['"])([^'"]+)(['"])/g, (_, prefix, dependency, suffix) => {
          if (dependency === 'node:crypto') return prefix + dependency + suffix
          const resolved = resolve('/', dirname(path), dependency + '.ts').slice(1)
          if (!dependency.startsWith('.') || !compiled.includes(resolved)) fail('presence_mobile_source_import_invalid')
          return prefix + dependency + '.mjs' + suffix
        })
      const destination = join(directory, path.replace(/\.ts$/, '.mjs'))
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, transformed)
    }
    const load = path => import(pathToFileURL(join(directory, path.replace(/\.ts$/, '.mjs'))).href)
    const [{ ApiCache }, { PresenceScopeCache }, { presenceGrantPayload }] = await Promise.all([
      load('apps/mobile/lib/api-cache.ts'), load('apps/mobile/lib/presence-scope.ts'), load('lib/live/presence.ts'),
    ])
    return { directory, sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree, hashes: manifest.hashes, ApiCache, PresenceScopeCache, presenceGrantPayload,
      close() { rmSync(directory, { recursive: true, force: true }) } }
  } catch (cause) { rmSync(directory, { recursive: true, force: true }); throw cause }
}
