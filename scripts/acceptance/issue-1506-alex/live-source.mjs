// Compile the exact reviewed product sources with Node's TypeScript transform.
// No product algorithm is copied or patched; imports only gain their .mjs suffix.
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

export const LIVE_SOURCE_COMMIT = '7cd5a2c0836ee5ee1e0b91213e0a9fcee35c2032'
export const LIVE_SOURCE_HASHES = Object.freeze({
  'lib/live/channel.ts': '38b8f75e8e0888f81789da1f98a7e051c3462a36ce358e6748c35fa30cebf888',
  'lib/live/tab-share.ts': '38d80a253b7c3f1522cd79366fc03b46a4065ccf7b52a10df5199092664b7b9f',
  'lib/live/revisions.ts': 'bd2b351ade97a5b0f3f12f43d606ce9f9d8eca9b90de33400be94203d9d76328',
  'lib/live/events.ts': 'd32a129473bdb1213d9aa17ee578c731ad23e7fe8f29d2fd3f26c233465f48b5',
  'lib/swr/persistent-cache.ts': 'd1e65d589ea138d3fde4e2287a5945a28697222e7b5d5efb9967e6de5fe0650a',
  'lib/swr/cache-policy.ts': 'abcca8af114ef23d16c2ab5402ef44f5e41cac5bf065514b441f483ccb37219f',
  'lib/swr/indexed-db.ts': 'a0398fe6d422856d4ab42f316b4888b1f775e92f005e29dabf57dd2ef6ed9809',
  'hooks/use-live-key.tsx': 'b285e80146fa936d2c40fbfdb23626e1c4630d023cde8a905a1345f22de8ba97',
  'components/coordinator/coordinator-chat.tsx': '3fee40aa285a9d027c4eba7eedaf2c126dc270894350063dc46e173ca4fe72fa',
})

export function prepareLiveSource(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw new Error('live_source_required')
  const sources = new Map()
  for (const [path, expected] of Object.entries(LIVE_SOURCE_HASHES)) {
    let bytes
    try { bytes = readFileSync(resolve(sourceRoot, path)) } catch { throw new Error('live_source_missing') }
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('live_source_mismatch')
    sources.set(path, bytes.toString('utf8'))
  }
  const directory = mkdtempSync(join(tmpdir(), 'mikka-1506-live-'))
  try {
    for (const [path, source] of sources) {
      if (!path.endsWith('.ts')) continue // Hook/component are provenance checks, not a simulated React render.
      const transformed = stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false })
        .replace(/(from\s*['"])(\.[^'"]+)(['"])/g, (_, prefix, dependency, suffix) => prefix + dependency + '.mjs' + suffix)
      if (/from\s*['"](?:[^.]|\.\.)/.test(transformed)) throw new Error('live_source_import_invalid')
      const destination = join(directory, path.replace(/\.ts$/, '.mjs'))
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, transformed)
    }
    return { directory, sourceCommit: LIVE_SOURCE_COMMIT, hashes: LIVE_SOURCE_HASHES,
      close() { rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
