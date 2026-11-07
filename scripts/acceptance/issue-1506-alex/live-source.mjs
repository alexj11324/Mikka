// Compile the exact reviewed product sources with Node's TypeScript transform.
// No product algorithm is copied or patched; imports only gain their .mjs suffix.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

// Local content review base, not a claim that this commit has been published.
export const LIVE_SOURCE_CONTENT_BASE = 'aaecbdba0472af1a4ad921913267118741e74f1a'
// Exact explicitly supplied application source; no deployment claim. The future workflow/control remain disabled
// until the separately verified production application SHA is supplied.
export const LIVE_SOURCE_COMMIT = 'a1902d720c5cd6b3ff45d94cfe1bc154d4aa38b9'
export const LIVE_SOURCE_HASHES = Object.freeze({
  'lib/live/channel.ts': 'd68014bb7b052af013207e4eaebc0130ffdb9e58cd5f61b54b13dfc49f6ef9f7',
  'lib/live/tab-share.ts': '38d80a253b7c3f1522cd79366fc03b46a4065ccf7b52a10df5199092664b7b9f',
  'lib/live/revisions.ts': 'bd2b351ade97a5b0f3f12f43d606ce9f9d8eca9b90de33400be94203d9d76328',
  'lib/live/events.ts': 'd32a129473bdb1213d9aa17ee578c731ad23e7fe8f29d2fd3f26c233465f48b5',
  'lib/live/presence.ts': '03825f69104f2dad83701a6faa6d6ab76326b5dba6f8214249a60eff46249ea0',
  'lib/swr/persistent-cache.ts': 'd1e65d589ea138d3fde4e2287a5945a28697222e7b5d5efb9967e6de5fe0650a',
  'lib/swr/cache-policy.ts': 'abcca8af114ef23d16c2ab5402ef44f5e41cac5bf065514b441f483ccb37219f',
  'lib/swr/indexed-db.ts': 'a0398fe6d422856d4ab42f316b4888b1f775e92f005e29dabf57dd2ef6ed9809',
  'hooks/use-live-key.tsx': 'd5f25908143a4038e53a45a1f5fab8143dd6b28f7c13fabce4bd6bc2ffbc7397',
  'components/coordinator/coordinator-chat.tsx': '16a648b12638649bd630ddeb5f8f02ea154318ccbb737329d43afe7f7c690361',
})

export function prepareLiveSource(sourceRoot, { sourceBase = LIVE_SOURCE_COMMIT } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sourceBase ?? '')) throw new Error('live_source_commit_unset')
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw new Error('live_source_required')
  const sources = new Map()
  for (const [path, expected] of Object.entries(LIVE_SOURCE_HASHES)) {
    let bytes
    try { bytes = readFileSync(resolve(sourceRoot, path)) } catch { throw new Error('live_source_missing') }
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('live_source_mismatch')
    sources.set(path, bytes.toString('utf8'))
  }
  let checkout
  try {
    checkout = execFileSync('git', ['-C', resolve(sourceRoot), 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, maxBuffer: 1_000,
    }).trim()
  } catch (error) { throw new Error('live_source_revision_unavailable', { cause: error }) }
  if (checkout !== sourceBase) throw new Error('live_source_commit_mismatch')
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
    return { directory, sourceCommit: sourceBase, contentReviewCommit: LIVE_SOURCE_CONTENT_BASE, hashes: LIVE_SOURCE_HASHES,
      close() { rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
