// gh supplies the existing authorized identity. Receipts contain metadata only.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const api = endpoint => JSON.parse(execFileSync('gh', ['api', `repos/alexj11324/Mikka/${endpoint}`], { encoding: 'utf8', maxBuffer: 32 << 20 }))
const seconds = (a,b) => {
  const value = (Date.parse(b)-Date.parse(a))/1000
  if (!Number.isFinite(value) || value < 0) throw Error('invalidTimingMetadata')
  return value
}

export function jobTimings(run, jobs) {
  return jobs.map(j => {
    const completed = j.status === 'completed' && j.conclusion !== 'skipped' && j.started_at && j.completed_at
    // A failed-job retry can return a successful job's original timestamps,
    // despite assigning it this attempt's ID and a later created_at.
    const retained = Boolean(completed && Date.parse(j.completed_at) < Date.parse(run.created_at))
    return { id:j.id,name:j.name,status:j.status,conclusion:j.conclusion,
      created_at:j.created_at,started_at:j.started_at,completed_at:j.completed_at,
      retained,retained_seconds:retained ? seconds(j.started_at,j.completed_at) : null,
      // Queue time excludes dependency wait and work retained from prior attempts.
      queue_seconds:completed && !retained && j.created_at ? seconds(j.created_at,j.started_at) : null,
      seconds:j.conclusion==='skipped' || retained ? 0 : completed ? seconds(j.started_at,j.completed_at) : null,
      steps:(j.steps??[]).map(s=>({name:s.name,conclusion:s.conclusion,seconds:s.started_at&&s.completed_at?seconds(s.started_at,s.completed_at):null})) }
  })
}

export function timingReceipt(run, jobs, originalRun = run) {
  if(run.status!=='completed')throw Error(`runIncomplete:${run.id}`)
  const measured = jobTimings(run, jobs)
  const active=measured.filter(j=>j.status==='completed' && j.conclusion!=='skipped' && !j.retained && j.seconds !== null)
  if (!active.length) throw Error(`runWithoutCompletedJobs:${run.id}`)
  const first=active.map(j=>j.started_at).sort()[0], last=active.map(j=>j.completed_at).sort().at(-1)
  return { id:run.id,url:run.html_url,sha:run.head_sha,event:run.event,attempt:run.run_attempt,conclusion:run.conclusion,
    created_at:run.created_at,first_started_at:first,last_completed_at:last,
    run_created_at:originalRun.created_at,run_lifetime_seconds:seconds(originalRun.created_at,last),
    first_queue_seconds:seconds(run.created_at,first),wall_seconds:seconds(run.created_at,last),execution_span_seconds:seconds(first,last),
    runner_minutes:active.reduce((sum,j)=>sum+j.seconds,0)/60,
    retained_job_count:measured.filter(j=>j.retained).length,jobs:measured }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ids = process.argv.slice(2)
  if (!ids.length || ids.some(id=>!/^\d+$/.test(id))) throw Error('numericRunIdsRequired')
  const receipts = ids.map(id=>{
    const originalRun=api(`actions/runs/${id}`)
    const run=api(`actions/runs/${id}/attempts/${originalRun.run_attempt}`), jobs=[]
    for(let page=1;;page++) {
      const data=api(`actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`)
      jobs.push(...data.jobs)
      if(jobs.length>=data.total_count)break
    }
    return timingReceipt(run, jobs, originalRun)
  })
  if(process.env.CI_TIMINGS_FILE)writeFileSync(process.env.CI_TIMINGS_FILE,JSON.stringify(receipts,null,2)+'\n')
  console.log(JSON.stringify(receipts,null,2))
}
