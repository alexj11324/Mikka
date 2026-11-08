// Build the same reviewed application graph directly into Vercel's Build Output
// API. Keep the existing production environment and migration guards: there is
// no framework detection, second install, or implicit Next build in this path.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { configuredDeploymentId } from '../../lib/deployment-id.mjs'
import { buildEnvironmentValues } from './web-deploy.mjs'
import { directDatabaseURL } from '../postgres-connection.mjs'

/** Closed observations only: protected compiler output never reaches public logs. */
export function buildFailureEvidence({ result, sourceSha, overlaySha, log }) {
  const sha = value => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value) ? value : null
  const signal = ['SIGABRT', 'SIGBUS', 'SIGILL', 'SIGKILL', 'SIGSEGV', 'SIGTERM'].includes(result.signal) ? result.signal : null
  const codes = ['EACCES', 'EAGAIN', 'E2BIG', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ETIMEDOUT']
  const databaseCodes = ['22023', '22P02', '23502', '23503', '23505', '23514', '25006', '40001', '40P01', '42501', '42703', '42804', '42883', '42P01', '53300', '53400', '55000', '57014', '57P01']
  const networkCodes = ['ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT']
  let lastObservedPhase = 'unknown', databaseCode = null, networkCode = null, observedSystemCode = null
  let lastTypecheckCommand = null
  const typescriptCodes = new Set()
  for (const rawLine of (log?.toString('utf8') ?? '').split('\n')) {
    const line = stripVTControlCharacters(rawLine)
    if (/^> node scripts\/build-subscription-worker\.mjs(?: &&|$)/.test(line)) lastObservedPhase = 'subscription-worker'
    if (/^> \S+ generate:agent-ui(?:\s|$)/.test(line)) lastObservedPhase = 'generate-agent-ui'
    if (/^> \S+ build:app(?:\s|$)/.test(line)) lastObservedPhase = 'build-app'
    if (/^> \S+ typecheck(?:\s|$)/.test(line)) lastObservedPhase = 'typecheck'
    if (line === '> tsrs --noEmit && tsrs --noEmit -p apps/api/tsconfig.json && pnpm --filter @mikka/frontend typecheck') lastTypecheckCommand = 'root-and-api'
    if (line === '> tsc --noEmit -p tsconfig.json') lastTypecheckCommand = 'frontend'
    if (line === 'migrate: starting') lastObservedPhase = 'migrate'
    if (!line.includes('.hosted-ui/') && /^\s+at .*\/scripts\/migrate\.mjs:\d+:\d+\)?$/.test(line)) lastObservedPhase = 'migrate'
    const typescriptCode = /\berror (TS[1-9]\d{3,4}):(?:\s|$)/.exec(line)?.[1]
    if (typescriptCode && typescriptCodes.size < 16) typescriptCodes.add(typescriptCode)
    const code = /\bcode:\s*['"]([A-Z0-9_]+)['"]/.exec(line)?.[1]
    const systemCode = codes.includes(code) ? code : /\bError:\s*([A-Z0-9_]+):/.exec(line)?.[1]
    if (codes.includes(systemCode)) observedSystemCode = systemCode
    if (databaseCodes.includes(code)) databaseCode = code
    if (networkCodes.includes(code)) networkCode = code
  }
  return { event: 'official_build_failure', sourceSha: sha(sourceSha), overlaySha: sha(overlaySha),
    exitStatus: Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : null,
    signal, processErrorCode: codes.includes(result.error?.code) ? result.error.code : null,
    lastObservedPhase, lastTypecheckCommand, typescriptCodes: [...typescriptCodes].sort(), databaseCode, networkCode, observedSystemCode,
    logBytes: log?.length ?? null, logSha256: log ? createHash('sha256').update(log).digest('hex') : null }
}

export function productionBuildEnvironment({ text, env, sourceSha, nodeVersion = process.version }) {
  if (!nodeVersion.startsWith('v24.')) throw new Error('webDeploy:node24Required')
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || sourceSha !== env.GITHUB_SHA
    || (env.VERCEL_GIT_COMMIT_SHA && env.VERCEL_GIT_COMMIT_SHA !== sourceSha)) throw new Error('webDeploy:sourceMismatch')
  const values = buildEnvironmentValues(text, env)
  // Vercel CLI 65.4's dotenv loader keeps a non-empty job value. Empty or
  // absent job values fall back to the filled file; do not decode job values.
  for (const key of Object.keys(values)) if (env[key]) values[key] = env[key]
  const deploymentId = configuredDeploymentId(env)
  if (!deploymentId) throw new Error('webDeploy:deploymentIdRequired')
  const build = { ...env, ...values, NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production',
    VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'alexj11324', VERCEL_GIT_REPO_SLUG: 'Mikka',
    VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: sourceSha,
    NEXT_PUBLIC_MIKKA_BUILD: sourceSha, NITRO_PRESET: 'vercel', MIKKA_DEPLOYMENT_ID: deploymentId }
  // A disposable acceptance identity must never be compiled into production.
  delete build.MIKKA_TEST_DEPLOYMENT_SHA
  delete build.MIKKA_LOCAL_TEST_ACCOUNTS
  delete build.MIKKA_TEST_ENVIRONMENT_FILE
  // Reject the same invalid migration inputs before spending time on a build.
  // The helper's direct-endpoint result is intentionally not assigned here.
  for (const key of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) {
    try { directDatabaseURL(build[key]) }
    catch (cause) { throw new Error(`webDeploy:databaseConnectionUrlInvalid:${key}`, { cause }) }
  }
  return build
}

export function buildVercel({ root = process.cwd(), env = process.env, file = '.vercel/.env.production.local' } = {}) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const buildEnv = productionBuildEnvironment({ text: readFileSync(resolve(root, file), 'utf8'), env, sourceSha })
  const manager = execFileSync('pnpm', ['--version'], { cwd: root, env: buildEnv, encoding: 'utf8' }).trim()
  if (manager !== '10.34.3') throw new Error('webDeploy:pinnedPnpmRequired')
  // A compiler error can quote paid UI source. Official diagnostics stay on
  // the ephemeral runner and are never sent to public logs or artifacts.
  const log = buildEnv.MIKKA_UI_OVERLAY_DIR ? openSync(resolve(env.RUNNER_TEMP || tmpdir(), 'official-web-build.log'), 'w', 0o600) : undefined
  let result
  try { result = spawnSync('pnpm', ['build'], { cwd: root, env: buildEnv, stdio: log === undefined ? 'inherit' : ['ignore', log, log] }) }
  finally { if (log !== undefined) closeSync(log) }
  if (result.error || result.status !== 0) {
    console.error(JSON.stringify(buildFailureEvidence({ result, sourceSha,
      overlaySha: buildEnv.MIKKA_UI_OVERLAY_SHA, log: log === undefined ? undefined
        : readFileSync(resolve(env.RUNNER_TEMP || tmpdir(), 'official-web-build.log')) })))
    throw new Error('webDeploy:buildFailed', { cause: result.error })
  }
  const config = JSON.parse(readFileSync(resolve(root, '.vercel/output/config.json'), 'utf8'))
  if (config.version !== 3 || !Array.isArray(config.routes)) throw new Error('webDeploy:prebuiltOutputInvalid')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildVercel() } catch (error) {
    console.error(/^webDeploy:[A-Za-z0-9,:_-]+$/.test(error?.message ?? '') ? error.message : 'webDeploy:prebuiltBuildFailed')
    process.exitCode = 1
  }
}
