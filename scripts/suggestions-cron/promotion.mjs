import { githubRead } from '../release/web-deploy.mjs'
import { readWebAuthority, readServingPromotion } from '../release/cloudflare-promoted-web.mjs'

const sha = /^[a-f0-9]{40}$/
const repo = 'alexj11324/Mikka'
const path = '.github/workflows/cloudflare-app-deploy.yml'

/** Find the successful observation of this exact source; reverify its public serving proof on every read. */
export async function readCronPromotion({ sourceCommit, token, fetchImpl = fetch, read = githubRead, verify = readServingPromotion, authority = readWebAuthority }) {
  if (!sha.test(sourceCommit ?? '') || !token) throw Error('cron_promotion_arguments_invalid')
  const serving = await authority(fetchImpl)
  if (serving.provider !== 'cloudflare' || !sha.test(serving.sha ?? '')) throw Error('cron_production_origin_invalid')
  const api = { token, fetchImpl }
  for (let page = 1; ; page++) {
    const listing = await read(`/actions/workflows/cloudflare-app-deploy.yml/runs?branch=main&per_page=100&page=${page}`, api)
    if (!Array.isArray(listing.workflow_runs)) throw Error('cron_promotion_listing_invalid')
    for (const run of listing.workflow_runs) {
      if (!sha.test(run.head_sha ?? '') || run.head_branch !== 'main' || run.path !== path || run.event !== 'workflow_dispatch'
        || run.status !== 'completed' || run.conclusion !== 'success' || run.repository?.full_name !== repo
        || run.head_repository?.full_name !== repo || !Number.isSafeInteger(run.id) || run.id < 1
        || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) continue
      const jobs = await read(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, api)
      if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) throw Error('cron_promotion_jobs_invalid')
      if (!jobs.jobs.some(job => job.name?.startsWith('Serving release ' + serving.sha + ' ') && job.status === 'completed' && job.conclusion === 'success')) continue
      const record = await verify(`actions:${run.id}:${run.run_attempt}`, { token, fetchImpl })
      if (record.product !== serving.sha || typeof record.releasePin !== 'string') throw Error('cron_promotion_source_mismatch')
      return { id: record.releasePin, sha: record.product }
    }
    if (listing.workflow_runs.length < 100) return null
  }
}
