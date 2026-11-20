import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { jobTimings } from './timings.mjs'
export function timingSummary(run, jobs, now = Date.now(), originalRun = run) {
  const measured = jobTimings(run, jobs)
  const completed = measured.filter(j => j.status === 'completed' && j.conclusion !== 'skipped' && !j.retained && j.seconds !== null)
  const minutes = completed.reduce((sum,j) => sum + j.seconds,0)/60
  const wall = (now-Date.parse(run.created_at))/1000
  const lifetime = (now-Date.parse(originalRun.created_at))/1000
  if (!Number.isFinite(wall) || wall < 0 || !Number.isFinite(lifetime) || lifetime < 0 || !Number.isFinite(minutes)) throw Error('invalidTimingMetadata')
  const retained = measured.filter(j => j.retained).length
  return `## Actions timing (at this gate)\n\n[Run ${run.id}, attempt ${run.run_attempt}](${run.html_url}/attempts/${run.run_attempt}): ${wall.toFixed(0)} s elapsed including queue; ${minutes.toFixed(2)} completed runner-minutes across ${completed.length} completed jobs. ${lifetime.toFixed(0)} s total run lifetime, including earlier attempts and time before retrying. ${retained} completed job${retained === 1 ? '' : 's'} retained from an earlier attempt; their original execution is excluded. Still-running gate/parallel jobs are excluded from runner-minutes. Final measurements use the completed-run collector.\n\n` +
    '| Completed job | Result | Seconds |\n| --- | --- | ---: |\n' + completed.map(j => `| ${j.name.replaceAll('|','/')} | ${j.conclusion} | ${((Date.parse(j.completed_at)-Date.parse(j.started_at))/1000).toFixed(0)} |`).join('\n')+'\n'
}
export async function main(env = process.env) {
  try {
    const api = async path => {
      const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${path}`, {
        headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw Error('timingMetadataUnavailable')
      return response.json()
    }
    const attempt = env.GITHUB_RUN_ATTEMPT
    if (!/^[1-9]\d*$/.test(attempt ?? '')) throw Error('timingAttemptUnavailable')
    const [originalRun,run,page] = await Promise.all([api(''),api(`/attempts/${attempt}`),api(`/attempts/${attempt}/jobs?per_page=100`)])
    if (page.total_count > page.jobs.length) throw Error('timingMetadataTruncated')
    appendFileSync(env.GITHUB_STEP_SUMMARY,timingSummary(run,page.jobs,Date.now(),originalRun))
  } catch (error) {
    // Telemetry cannot turn a failed check green or replace gate validation.
    // Keep the explicit gap instead of inventing durations on API failure.
    appendFileSync(env.GITHUB_STEP_SUMMARY,`\nActions timing unavailable (${error.name}); final collector evidence required.\n`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
