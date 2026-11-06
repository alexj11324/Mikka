// Build the same reviewed application graph directly into Vercel's Build Output
// API. Keep the existing production environment and migration guards: there is
// no framework detection, second install, or implicit Next build in this path.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { configuredDeploymentId } from '../../lib/deployment-id.mjs'
import { buildEnvironment } from './web-deploy.mjs'

export function productionBuildEnvironment({ text, env, sourceSha, nodeVersion = process.version }) {
  if (!/^v24\./.test(nodeVersion)) throw new Error('webDeploy:node24Required')
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || sourceSha !== env.GITHUB_SHA
    || (env.VERCEL_GIT_COMMIT_SHA && env.VERCEL_GIT_COMMIT_SHA !== sourceSha)) throw new Error('webDeploy:sourceMismatch')
  const values = parseEnv(buildEnvironment(text, env))
  const deploymentId = configuredDeploymentId(env)
  if (!deploymentId) throw new Error('webDeploy:deploymentIdRequired')
  const build = { ...env, ...values, NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: sourceSha,
    NEXT_PUBLIC_MIKKA_BUILD: sourceSha, NITRO_PRESET: 'vercel', MIKKA_DEPLOYMENT_ID: deploymentId }
  // A disposable acceptance identity must never be compiled into production.
  delete build.MIKKA_TEST_DEPLOYMENT_SHA
  delete build.MIKKA_LOCAL_TEST_ACCOUNTS
  delete build.MIKKA_TEST_ENVIRONMENT_FILE
  return build
}

export function buildVercel({ root = process.cwd(), env = process.env, file = '.vercel/.env.production.local' } = {}) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const buildEnv = productionBuildEnvironment({ text: readFileSync(resolve(root, file), 'utf8'), env, sourceSha })
  const manager = execFileSync('pnpm', ['--version'], { cwd: root, env: buildEnv, encoding: 'utf8' }).trim()
  if (manager !== '10.34.3') throw new Error('webDeploy:pinnedPnpmRequired')
  const result = spawnSync('pnpm', ['build'], { cwd: root, env: buildEnv, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error('webDeploy:buildFailed')
  const config = JSON.parse(readFileSync(resolve(root, '.vercel/output/config.json'), 'utf8'))
  if (config.version !== 3 || !Array.isArray(config.routes)) throw new Error('webDeploy:prebuiltOutputInvalid')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildVercel() } catch (error) {
    console.error(/^webDeploy:[A-Za-z0-9,:_-]+$/.test(error?.message ?? '') ? error.message : 'webDeploy:prebuiltBuildFailed')
    process.exitCode = 1
  }
}
