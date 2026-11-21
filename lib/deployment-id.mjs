// Stable, URL-safe identity for one production deployment across the web, API and worker images.
// A rerun gets a distinct identifier even when the source revision is unchanged.

import { pathToFileURL } from 'node:url'

const MAX_LENGTH = 32
const ALLOWED = /^[A-Za-z0-9_-]+$/

export function isValidDeploymentId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_LENGTH && ALLOWED.test(id)
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

/** The id selected by the release workflow, or undefined outside a release build. */
export function configuredDeploymentId(env = process.env) {
  const id = env.MIKKA_DEPLOYMENT_ID
  if (!id) return undefined
  if (!isValidDeploymentId(id)) throw new Error(`MIKKA_DEPLOYMENT_ID ${JSON.stringify(id)} is not a valid release id`)
  return id
}

// `node lib/deployment-id.mjs` prints the id for this run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${buildDeploymentId({ sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })}\n`)
}
