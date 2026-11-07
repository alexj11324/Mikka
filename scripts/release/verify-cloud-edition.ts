import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isCloudEdition } from '../../lib/edition'

/** Refuse the rollout until both the official build environment and Vercel's
 * actual production runtime agree. Never print the environment inventory. */
export async function verifyCloudEdition(env: Record<string, string | undefined> = process.env, read: typeof fetch = fetch) {
  if (!isCloudEdition(env)) throw new Error('webDeploy:buildCloudEditionRequired')
  const { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: project, VERCEL_ORG_ID: team } = env
  if (!token || !project || !team) throw new Error('webDeploy:editionVerificationConfigurationRequired')
  const api = async (path: string) => {
    const response = await read(`https://api.vercel.com${path}?teamId=${encodeURIComponent(team)}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`webDeploy:editionVerificationFailed:${response.status}`)
    return response.json()
  }
  const inventory = await api(`/v10/projects/${encodeURIComponent(project)}/env`)
  const rows = Array.isArray(inventory.envs) ? inventory.envs.filter((row: { key?: string; target?: string[] }) => row.key === 'MIKKA_EDITION' && row.target?.includes('production')) : []
  if (rows.length !== 1 || typeof rows[0].id !== 'string') throw new Error('webDeploy:vercelCloudEditionRequired')
  const value = await api(`/v1/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(rows[0].id)}`)
  if (typeof value.value !== 'string' || !isCloudEdition({ MIKKA_EDITION: value.value })) throw new Error('webDeploy:vercelCloudEditionRequired')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await verifyCloudEdition(); console.log('Official build and Vercel production both select the cloud edition') }
  catch (error) {
    console.error(/^webDeploy:[A-Za-z0-9:]+$/.test((error as Error)?.message ?? '') ? (error as Error).message : 'webDeploy:editionVerificationFailed')
    process.exitCode = 1
  }
}
