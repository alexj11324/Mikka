// The Next.js deploymentId for Vercel Skew Protection (docs/operations/web-deploy.md).
// A prebuilt upload has no Vercel-assigned id at build time, so the production
// workflow picks one: unique per run attempt, so a re-run of a commit is a new
// deployment. Vercel rejects an id that starts with dpl_, is longer than 32
// characters, uses other characters, or was used before.

import { pathToFileURL } from 'node:url'

const MAX_LENGTH = 32
const ALLOWED = /^[A-Za-z0-9_-]+$/

export function isValidDeploymentId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_LENGTH && ALLOWED.test(id) && !id.startsWith('dpl_')
}

/** `<sha prefix>-<run id>-<run attempt>`; the sha prefix shrinks before the run fields do. */
export function buildDeploymentId({ sha, runId, runAttempt }) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha ?? '')) throw new Error(`deployment id: expected a commit sha, got ${JSON.stringify(sha)}`)
  if (!/^\d+$/.test(String(runId ?? ''))) throw new Error(`deployment id: expected a numeric run id, got ${JSON.stringify(runId)}`)
  if (!/^\d+$/.test(String(runAttempt ?? ''))) throw new Error(`deployment id: expected a numeric run attempt, got ${JSON.stringify(runAttempt)}`)
  const suffix = `-${runId}-${runAttempt}`
  const shaLength = Math.min(12, MAX_LENGTH - suffix.length)
  if (shaLength < 7) throw new Error(`deployment id: run fields ${suffix} leave no room for the commit`)
  const id = `${sha.slice(0, shaLength).toLowerCase()}${suffix}`
  if (!isValidDeploymentId(id)) throw new Error(`deployment id: built an invalid id ${JSON.stringify(id)}`)
  return id
}

/** The id the production workflow chose (apps/frontend/vite.config.mjs and
 * apps/frontend/scripts/deployment-plugin.mjs read it back), or undefined outside it. */
export function configuredDeploymentId(env = process.env) {
  const id = env.MIKKA_DEPLOYMENT_ID
  if (!id) return undefined
  if (!isValidDeploymentId(id)) throw new Error(`MIKKA_DEPLOYMENT_ID ${JSON.stringify(id)} is not a valid Vercel deployment id`)
  // Next lets NEXT_DEPLOYMENT_ID replace the configured id; two ids would split
  // the build from what Skew Protection routes by.
  if (env.NEXT_DEPLOYMENT_ID && env.NEXT_DEPLOYMENT_ID !== id) throw new Error('NEXT_DEPLOYMENT_ID and MIKKA_DEPLOYMENT_ID disagree')
  return id
}

// .github/workflows/web-deploy.yml: `node lib/deployment-id.mjs` prints the id for this run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${buildDeploymentId({ sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })}\n`)
}
