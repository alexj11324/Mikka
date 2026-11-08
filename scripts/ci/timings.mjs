// gh supplies the existing authorized identity. Receipts contain metadata only.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const api = endpoint => JSON.parse(execFileSync('gh', ['api', `repos/alexj11324/Mikka/${endpoint}`], { encoding: 'utf8', maxBuffer: 32 << 20 }))
const seconds = (a,b) => (Date.parse(b)-Date.parse(a))/1000
export function timingReceipt(run, jobs) {
  if(run.status!=='completed')throw Error(`runIncomplete:${run.id}`)
  const active=jobs.filter(j=>j.conclusion!=='skipped' && j.started_at && j.completed_at)
  if (!active.length) throw Error(`runWithoutCompletedJobs:${run.id}`)
  const first=active.map(j=>j.started_at).sort()[0], last=active.map(j=>j.completed_at).sort().at(-1)
  return { id:run.id,url:run.html_url,sha:run.head_sha,event:run.event,attempt:run.run_attempt,conclusion:run.conclusion,
    created_at:run.created_at,first_started_at:first,last_completed_at:last,
    first_queue_seconds:seconds(run.created_at,first),wall_seconds:seconds(run.created_at,last),execution_span_seconds:seconds(first,last),
    runner_minutes:active.reduce((sum,j)=>sum+seconds(j.started_at,j.completed_at)/60,0),
    jobs:jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion,
      created_at:j.created_at,started_at:j.started_at,completed_at:j.completed_at,
      // GitHub's job-created-to-start interval, distinct from dependency wait.
      queue_seconds:j.conclusion!=='skipped' && j.created_at && j.started_at ? seconds(j.created_at,j.started_at) : null,
      seconds:j.conclusion==='skipped'?0:seconds(j.started_at,j.completed_at),
      steps:(j.steps??[]).map(s=>({name:s.name,conclusion:s.conclusion,seconds:s.started_at&&s.completed_at?seconds(s.started_at,s.completed_at):null}))})) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ids = process.argv.slice(2)
  if (!ids.length || ids.some(id=>!/^\d+$/.test(id))) throw Error('numericRunIdsRequired')
  const receipts = ids.map(id=>{
    const run=api(`actions/runs/${id}`), jobs=[]
    for(let page=1;;page++) {
      const data=api(`actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`)
      jobs.push(...data.jobs)
      if(jobs.length>=data.total_count)break
    }
    return timingReceipt(run, jobs)
  })
  if(process.env.CI_TIMINGS_FILE)writeFileSync(process.env.CI_TIMINGS_FILE,JSON.stringify(receipts,null,2)+'\n')
  console.log(JSON.stringify(receipts,null,2))
}
