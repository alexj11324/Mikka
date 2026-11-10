// Compile the exact reviewed product sources with Node's TypeScript transform.
// No product algorithm is copied or patched; imports only gain their .mjs suffix.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, posix } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

// Local content review base, not a claim that this commit has been published.
export const LIVE_SOURCE_CONTENT_BASE = '1c7698655405b289d7fdbd814713d15e542cc2bb'
// Exact explicitly supplied application source; no deployment claim. The future workflow/control remain disabled
// until the separately verified production application SHA is supplied.
export const LIVE_SOURCE_COMMIT = 'cc389d61e8a85206d17616e4326a660283a1b2bd'
export const LIVE_SOURCE_HASHES = Object.freeze({
  'lib/live/channel.ts': '7d1d16e02ea9ca8256812312eafc96c0591cc1df1c6a463e0216e420d37b8ede',
  'lib/live/tab-share.ts': '38d80a253b7c3f1522cd79366fc03b46a4065ccf7b52a10df5199092664b7b9f',
  'lib/live/revisions.ts': 'bd2b351ade97a5b0f3f12f43d606ce9f9d8eca9b90de33400be94203d9d76328',
  'lib/live/events.ts': 'd32a129473bdb1213d9aa17ee578c731ad23e7fe8f29d2fd3f26c233465f48b5',
  'lib/live/presence.ts': '03825f69104f2dad83701a6faa6d6ab76326b5dba6f8214249a60eff46249ea0',
  'lib/swr/persistent-cache.ts': 'd1e1793960a0401fc2e8cb3a9b29e2a894828096e444fc086a6d1ebe5d34df1a',
  'lib/swr/cache-policy.ts': 'b87b7847e2ea02cf4d25b8d106dc33ba30b2e8b3862d1843a7d6ada4b93e51a0',
  'lib/swr/indexed-db.ts': 'a0398fe6d422856d4ab42f316b4888b1f775e92f005e29dabf57dd2ef6ed9809',
  'hooks/use-live-key.tsx': '5e70417507a1a07ad39234cf9695499c80df418414d54f4a3605033637f06857',
  'components/coordinator/coordinator-chat.tsx': '0a08f40ee2430fdae1eec6165a8bb3af36b85d886ce69327d4eb1ebd45d0f5b0',
  'lib/swr/read-observer.ts': '2c4f60539d1eb8d8e607490268fe065fa03b6f1b27e796fa23f5f35bd670499b',
  'components/swr-defaults.tsx': 'cd77353db8fdc38f6527ea5e00bd1227ecb6c8167350eff254effb3b41e8be33',
})

/** Only imports resolving to another exact pinned runtime module are allowed. */
export function resolveLiveImport(path, dependency) {
  if (!/^\.\.?\/[a-zA-Z0-9_./-]+$/.test(dependency) || dependency.includes('\\')) throw new Error('live_source_import_invalid')
  const target = posix.normalize(posix.join(posix.dirname(path), dependency.endsWith('.ts') ? dependency : dependency + '.ts'))
  if (!target.endsWith('.ts') || !Object.hasOwn(LIVE_SOURCE_HASHES, target)) throw new Error('live_source_import_invalid')
  const relative = posix.relative(posix.dirname(path), target.replace(/\.ts$/, '.mjs'))
  return relative.startsWith('.') ? relative : './' + relative
}

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
        .replace(/(from\s*['"])([^'"]+)(['"])/g, (_, prefix, dependency, suffix) =>
          prefix + resolveLiveImport(path, dependency) + suffix)
      const destination = join(directory, path.replace(/\.ts$/, '.mjs'))
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, transformed)
    }
    return { directory, sourceCommit: sourceBase, contentReviewCommit: LIVE_SOURCE_CONTENT_BASE, hashes: LIVE_SOURCE_HASHES,
      close() { rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
