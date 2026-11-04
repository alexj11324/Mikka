import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const APPLICATION_SOURCE = '5b81321dfd3bbc3413d71af258433e5e9ba73dfb'
export const OBSERVED_CLOUD_WORKER_SOURCE = '3def948dd00ec5aac59a04f6bc043a1d291d7683'

/** Pure parsing only. Never imports a database driver or opens a connection.
 * Neon documents the -pooler suffix on its endpoint hostname as pooled. A
 * non-Neon or missing URL is unknown, never evidence of a direct connection. */
export function classifyDatabaseURL(value) {
  const unknown = { recognized: false, neon: null, isPooler: null, classification: 'unknown' }
  if (typeof value !== 'string' || !value || value.length > 16384) return unknown
  try {
    const parsed = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return unknown
    const host = parsed.hostname.toLowerCase(), endpoint = host.split('.')[0]
    if (!host.endsWith('.neon.tech') || !/^ep-[a-z0-9-]+$/.test(endpoint)) return { ...unknown, neon: false }
    const isPooler = endpoint.endsWith('-pooler')
    return { recognized: true, neon: true, isPooler, classification: isPooler ? 'neon-pooled' : 'neon-direct' }
  } catch { return unknown }
}

export function databaseConnectionMetadata({ env = process.env, verifySource = () => {
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw Error('metadata_source_dirty')
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} } = {}) {
  if (env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || env.GITHUB_REF !== 'refs/heads/acceptance/proactive-1157-1163'
    || env.GITHUB_EVENT_NAME !== 'push') throw Error('metadata_workflow_scope_rejected')
  if (env.DB_METADATA_SOURCE_SHA !== APPLICATION_SOURCE || verifySource() !== APPLICATION_SOURCE) throw Error('metadata_source_mismatch')
  const allowed = env.DB_METADATA_SECRET_READ === 'success'
  const connection = allowed ? classifyDatabaseURL(env.MIKKA_DATABASE_URL) : classifyDatabaseURL(undefined)
  return { schemaVersion: 1, status: connection.recognized ? 'observed' : 'unavailable',
    observedAt: new Date().toISOString(), runId: /^[0-9]+$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : null,
    source: { application: APPLICATION_SOURCE, cloudWorkerObserved: OBSERVED_CLOUD_WORKER_SOURCE,
      cloudWorkerProvenance: 'existing-Vercel-plain-setting-reported-by-coordinator' },
    configurationSource: { service: 'Infisical', projectId: '89850d6a-f020-4936-863e-df77380dfe40', environment: 'prod',
      path: '/vercel', name: 'MIKKA_DATABASE_URL', namedReadConfirmed: allowed, directlyObservedDeployedValue: false },
    connection, databaseConnectionAttempted: false, sqlExecuted: false, applicationSessionOpened: false,
    providerInvoked: false, configurationChanged: false, privateConnectionDataEmitted: false,
    missingDoesNotProveProductionAbsence: true }
}

function main() {
  let result
  try { result = databaseConnectionMetadata() }
  catch (error) { result = { schemaVersion: 1, status: 'unavailable', error: /^metadata_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'metadata_failed' } }
  finally { delete process.env.MIKKA_DATABASE_URL }
  const encoded = JSON.stringify(result, null, 2) + '\n'
  const output = resolve(process.env.DB_METADATA_OUTPUT ?? 'db-connection-metadata/results.json')
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, encoded) } finally { closeSync(fd) }
  console.log(JSON.stringify(result))
  if (result.status !== 'observed') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
