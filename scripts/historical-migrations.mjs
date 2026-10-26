// Exact historical imports reviewed as one immutable set. No pattern/env bypass.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
export const HISTORICAL_MANIFEST_SHA256 = '5e6d89181b8b78295f3b17d70915726da6e9844943a40e2d5722f192a46c1d9f'
export const fullHash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifestURL = new URL('../drizzle/historical-imports.json', import.meta.url)

/** Pure file validation also runs before migrations connect to a database. */
export function historicalImports(files, manifestBytes = readFileSync(manifestURL)) {
  if (fullHash(manifestBytes) !== HISTORICAL_MANIFEST_SHA256) throw new Error('Historical migration manifest digest mismatch')
  const manifest = JSON.parse(manifestBytes.toString())
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length !== 32) throw new Error('Invalid historical migration manifest')
  const seen = new Set()
  for (const entry of manifest.entries) {
    if (!/^drizzle\/\d{14}_[a-z0-9_]+\.sql$/.test(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{40}$/.test(entry.sourceCommit) || seen.has(entry.path)) throw new Error('Invalid historical migration entry')
    seen.add(entry.path)
    const name = entry.path.slice('drizzle/'.length)
    const matches = files.filter(file => file.name === name)
    if (matches.length !== 1 || fullHash(matches[0].content) !== entry.sha256) throw new Error(`Historical migration missing, duplicate or changed: ${entry.path}`)
  }
  return manifest.entries
}
const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })

/** Frozen Git provenance is a development/CI gate, never a production network dependency. */
export function verifyHistoricalSources(entries, readSource = (commit, path) => git('show', `${commit}:${path}`)) {
  for (const entry of entries) {
    if (fullHash(readSource(entry.sourceCommit, entry.path)) !== entry.sha256) throw new Error(`Historical migration source mismatch: ${entry.path}`)
  }
}
export function fetchHistoricalSources(entries) {
  for (const commit of new Set(entries.map(entry => entry.sourceCommit))) {
    try { git('cat-file', '-e', `${commit}^{commit}`) }
    catch { git('fetch', '--no-tags', '--depth=1', 'origin', commit) }
  }
}
/** A failed fresh read is an error, never a stale/null comparison. */
export function currentMainMigrations(runGit = git) {
  // Each invocation owns a ref; unrelated/concurrent fetches cannot replace it.
  const ref = `refs/mikka-migration-check/${randomUUID()}`
  let sha
  try {
    runGit('fetch', '--no-tags', '--depth=1', 'origin', `refs/heads/main:${ref}`)
    sha = runGit('rev-parse', ref).toString().trim()
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid current main commit')
  } finally {
    runGit('update-ref', '-d', ref)
  }
  const files = runGit('ls-tree', '--name-only', sha, 'drizzle/').toString().trim().split('\n').filter(Boolean).map(path => path.slice('drizzle/'.length))
  if (!files.length) throw new Error('Current main migration inventory unavailable')
  return { sha, files }
}
