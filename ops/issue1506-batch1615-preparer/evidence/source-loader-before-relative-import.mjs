// Compile the exact reviewed product sources with Node's TypeScript transform.
// No product algorithm is copied or patched; imports only gain their .mjs suffix.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, posix } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

// Local content review base, not a claim that this commit has been published.
export const LIVE_SOURCE_CONTENT_BASE = 'aaecbdba0472af1a4ad921913267118741e74f1a'
// Exact explicitly supplied application source; no deployment claim. The future workflow/control remain disabled
// until the separately verified production application SHA is supplied.
export const LIVE_SOURCE_COMMIT = '0d379dd92fd2d7b3f2b307030c3bcd8234426d0e'
export const LIVE_SOURCE_HASHES = Object.freeze({
  'lib/live/channel.ts': '8b8a6234419847d84bb0d6ed72145ce7b52883d818f84bfe9d217592cae3176b',
  'lib/live/tab-share.ts': '38d80a253b7c3f1522cd79366fc03b46a4065ccf7b52a10df5199092664b7b9f',
  'lib/live/revisions.ts': 'bd2b351ade97a5b0f3f12f43d606ce9f9d8eca9b90de33400be94203d9d76328',
  'lib/live/events.ts': 'd32a129473bdb1213d9aa17ee578c731ad23e7fe8f29d2fd3f26c233465f48b5',
  'lib/live/presence.ts': '03825f69104f2dad83701a6faa6d6ab76326b5dba6f8214249a60eff46249ea0',
  'lib/swr/persistent-cache.ts': 'b7750de029f5462bee61efba2642ccfa894e08a981a75c97f5852e715b5f9b1f',
  'lib/swr/cache-policy.ts': 'abcca8af114ef23d16c2ab5402ef44f5e41cac5bf065514b441f483ccb37219f',
  'lib/swr/indexed-db.ts': 'a0398fe6d422856d4ab42f316b4888b1f775e92f005e29dabf57dd2ef6ed9809',
  'hooks/use-live-key.tsx': '5e70417507a1a07ad39234cf9695499c80df418414d54f4a3605033637f06857',
  'components/coordinator/coordinator-chat.tsx': '53ff7f4491b9749d0c0cfa6f4b2b55c49d0af8441be2e336331489963a684473',
  'lib/swr/read-observer.ts': '4769b262e56c4ecf6a43e96cbbcafd86294209bbef6c3abe8cb016063cf49463',
  'components/swr-defaults.tsx': 'cd77353db8fdc38f6527ea5e00bd1227ecb6c8167350eff254effb3b41e8be33',
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
