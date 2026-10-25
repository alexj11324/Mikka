import { Pool } from 'pg'
import { ScheduleStore } from '../lib/schedules/store'
const url=process.env.SCHEDULE_TEST_DATABASE_URL
if(!url || !['localhost','127.0.0.1'].includes(new URL(url).hostname) || !/179|schedule/.test(new URL(url).pathname)) throw new Error('isolated schedule DB required')
const pool=new Pool({connectionString:url})
const store=new ScheduleStore(pool,async(_owner,_workspace,work)=>work(),()=>new Date(process.env.SCHEDULE_TEST_CLOCK!))
async function main() {
  const claim=await store.claim()
  process.stdout.write(JSON.stringify(claim)+'\n')
  // Parent must SIGKILL this real process before execution/acknowledgment.
  process.stdin.resume()
}
main().catch(()=>{process.exitCode=1})
