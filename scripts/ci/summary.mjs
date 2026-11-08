import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
export function timingSummary(run, jobs, now = Date.now()) {
  const completed = jobs.filter(j => j.status === 'completed' && j.conclusion !== 'skipped' && j.started_at && j.completed_at)
  const minutes = completed.reduce((sum,j) => sum + (Date.parse(j.completed_at)-Date.parse(j.started_at))/60_000,0)
  const wall = (now-Date.parse(run.created_at))/1000
  if (!Number.isFinite(wall) || !Number.isFinite(minutes)) throw Error('invalidTimingMetadata')
  return `## Actions timing (at this gate)\n\n[Run ${run.id}](${run.html_url}): ${wall.toFixed(0)} s elapsed including queue; ${minutes.toFixed(2)} completed runner-minutes across ${completed.length} completed jobs. Still-running gate/parallel jobs are excluded from runner-minutes. Final measurements use the completed-run collector.\n\n` +
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
    const [run,page] = await Promise.all([api(''),api('/jobs?per_page=100')])
    if (page.total_count > page.jobs.length) throw Error('timingMetadataTruncated')
    appendFileSync(env.GITHUB_STEP_SUMMARY,timingSummary(run,page.jobs))
  } catch (error) {
    // Telemetry cannot turn a failed check green or replace gate validation.
    // Keep the explicit gap instead of inventing durations on API failure.
    appendFileSync(env.GITHUB_STEP_SUMMARY,`\nActions timing unavailable (${error.name}); final collector evidence required.\n`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
